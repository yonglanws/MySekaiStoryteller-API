/**
 * 按出场组合动态挑选官方 PJSK 对白样例（来自 msst-ai-lab 中文语料库）。
 *
 * 只用作 Stage 2 对白的语气/换行/停顿/短反应 few-shot，帮助模型脱离书面齐整句，
 * 贴近各团体的口语节奏。遵守站内规范：Wonderhoy / 宁宁号。
 */

interface UnitExcerpt {
  id: 'lnf' | 'mmj' | 'vbs' | 'wxs' | 'n25' | 'general'
  label: string
  keywords: RegExp
  excerpt: string
}

const UNIT_EXCERPTS: readonly UnitExcerpt[] = [
  {
    id: 'n25',
    label: '25时，Nightcord见。',
    keywords: /奏|真冬|绘名|瑞希|kanade|mafuyu|ena|mizuki|nightcord|25时|25点/i,
    excerpt: `### 样例 A（Nightcord 日常与克制情绪）
瑞希：太好了——！\n不枉我修改到那么晚了～！
绘名：呼——\n总算是圆满完成了……
瑞希：绘绘，谢谢你在最后调整的时候帮我出主意！
绘名：为了帮你害我也没睡够……\nAmia，你今天一定要好好休息哦。
瑞希：（……终于要上传\n第一次让真冬露出笑容的那首歌了。）
奏：这下歌曲和MV就全都完成了。
瑞希：——希望能有很多人来听这首歌啊！
真冬：……嗯。
绘名：话说回来……画本身要是不行，\n你却客套地敷衍我，我会更不舒服！
瑞希：……果然还是被你听出来了。`
  },
  {
    id: 'lnf',
    label: 'Leo/need',
    keywords: /一歌|咲希|穗波|志步|ichika|saki|honami|shiho|leo/i,
    excerpt: `### 样例 B（Leo/need 放学后练习）
咲希：（……要是告诉小一我做了住院时的梦，\n一定会让她担心的。）
咲希：放学啦！\n一起去练习吧，小一！
一歌：嗯。\n咲希，感觉你今天好像很兴奋呢。
咲希：嗯！早上虽然差点迟到，\n但今天一天都平稳地度过了！
穗波：小希，你烧退了吗？\n我看你今天脸还是有点红……
志步：咦？咲希发烧了吗？\n那你还是回家休息……
咲希：没有啦！我没发烧！\n只是太期待了而已！
志步：……真的吗？\n好吧。但要是坚持不住了，一定要告诉我们哦。`
  },
  {
    id: 'mmj',
    label: 'MORE MORE JUMP!',
    keywords: /实乃理|遥|爱莉|雫|minori|haruka|airi|shizuku|more more/i,
    excerpt: `### 样例 C（MORE MORE JUMP! 排练与企划）
实乃理：哇……！谢谢你们！\n嘿嘿，那我来说明一下这个环节吧！
遥：在这个环节中，我们会走到当地的居民中，\n了解他们的生活。
爱莉：嗯。而在这期，我们会近距离接触\n小学的特别课外学习哦！
雫：不过，特别课外学习……\n具体要做什么呢？
实乃理：之后还会用收来的蔬菜制作咖喱哦！
爱莉：哼哼，那就趁现在把动作再顺一遍吧！
实乃理：是！`
  },
  {
    id: 'vbs',
    label: 'Vivid BAD SQUAD',
    keywords: /心羽|杏|彰人|冬弥|kohane|an|akito|touya|toya|vivid/i,
    excerpt: `### 样例 D（Vivid BAD SQUAD 街头与排练）
杏：——不愧是我的搭档！今天也这么完美！
心羽：哎呀！小杏！
心羽：讨厌，吓我一跳。\n店里的事忙完了吗？
杏：嗯！顾客也没那么多了，\n爸爸说他忙得过来，让我休息了。
杏：嗯？冬弥和彰人好像也过来了，\n你们看，在那边。
冬弥：让你们久等了。
彰人：……刚才那段副歌，\n节奏还能再往前推一点吧？
心羽：嗯！我再试一次！`
  },
  {
    id: 'wxs',
    label: 'Wonderlands×Showtime',
    keywords: /天马司|司|笑梦|宁宁|神代类|类|tsukasa|emu|nene|rui|wonder/i,
    excerpt: `### 样例 E（Wonderlands×Showtime 舞台排练）
笑梦：Wonderhoy——☆\n大家快来看！我想到一个超级厉害的新点子！
宁宁：……我有种非常不好的预感。
类：哼哼，听起来很有趣呢。\n说不定能派得上宁宁号的新机关……？
司：来吧，各位！！\n唱起来，跳起来！！为了美好的这一天！！
宁宁：好吵……
笑梦：咦？司，你今天特别有干劲呢！\n是发生了什么好事吗？`
  },
  {
    id: 'general',
    label: 'PJSK 通用对白节奏',
    keywords: /.*/,
    excerpt: `### 通用节奏样例（短反应 + 自然停顿 + 句中换行）
角色A：那个……其实……我不是不满意……
角色A：再说，我对那件事也一点也不懂——
角色B：不懂也没关系。\n我只是想知道，你看到它时的感受。
角色A：我的、感受吗……
角色A：……我……
角色B：——话说，你要是不觉得好，\n能不能直说啊？
角色B：所以……所以我才想问清楚。\n你真实的想法，到底是什么？`
  }
]

export function selectUnitFewShotExcerpts(
  cast: Array<{ name: string; fullName?: string; path?: string }>,
  scene: string
): string {
  const haystack = `${scene} ${cast.map((m) => `${m.name} ${m.fullName ?? ''} ${m.path ?? ''}`).join(' ')}`
  const picked: UnitExcerpt[] = []

  for (const unit of UNIT_EXCERPTS) {
    if (unit.id === 'general') continue
    if (unit.keywords.test(haystack)) {
      picked.push(unit)
    }
  }
  if (picked.length === 0) {
    picked.push(UNIT_EXCERPTS.find((u) => u.id === 'n25')!, UNIT_EXCERPTS.find((u) => u.id === 'lnf')!)
  } else if (picked.length === 1) {
    const general = UNIT_EXCERPTS.find((u) => u.id === 'general')!
    picked.push(general)
  }

  return picked
    .slice(0, 3)
    .map((u) => u.excerpt)
    .join('\n\n')
}

/**
 * 组合自适应 RAG 官方语料与静态团体 few-shot：
 * - 若 Pass B RAG 有命中（`promptBlock` 非空），优先使用动态检索的官方剧情、对白口吻与世界观设定，
 *   并附带显式反照抄护栏；若没有对白样本（`dialogueVoice` 为空），补一小段团体节奏样例。
 * - 若 RAG 未启用或无命中，无缝回退到 `selectUnitFewShotExcerpts`。
 */
export function buildCanonDialogueReferenceBlock(
  cast: Array<{ name: string; fullName?: string; path?: string }>,
  scene: string,
  ragContext?: {
    promptBlock?: string
    sections?: {
      dialogueVoice?: Array<{ text: string }>
    }
  } | null
): string {
  const ragBlock = ragContext?.promptBlock?.trim() ?? ''
  if (!ragBlock) {
    return selectUnitFewShotExcerpts(cast, scene)
  }
  const hasVoiceSamples = (ragContext?.sections?.dialogueVoice?.length ?? 0) > 0
  const guardrail =
    '（以上官方参考只用于学习称呼、断句、潜台词与互动节奏，以及核对官方事实，严禁照抄原句或复述原事件。）'
  if (hasVoiceSamples) {
    return `${ragBlock}\n\n${guardrail}`
  }
  return `${ragBlock}\n\n${guardrail}\n\n${selectUnitFewShotExcerpts(cast, scene)}`
}
