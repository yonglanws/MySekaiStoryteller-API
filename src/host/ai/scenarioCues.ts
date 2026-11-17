/**
 * PJSK 官方剧情语义音效（SE）、场景特效与虚拟歌手识别目录。
 *
 * 音效 ID 来自 `sound/scenario/se/`（`SCENARIO_SE_BUNDLES`）并在 328 集官方基线与
 * 近期活动剧情中逐条对照语境校验；导出时由 `cloudAssets.ts` 的 `ensureSe` 自动按需物化。
 */

export interface ScenarioSeCue {
  id: string
  file: string
  category: string
  description: string
  tags: string[]
  defaultVolume: number
}

export const CURATED_SCENARIO_SES: readonly ScenarioSeCue[] = [
  {
    id: 'se00053_b',
    file: 'se00053_b.mp3',
    category: 'transition',
    description: '心绪波动 / 回忆白光切入声（FlashbackIn 或重大转折前常用）',
    tags: ['flashback', 'memory', 'realization', 'transition', 'sigh'],
    defaultVolume: 0.9
  },
  {
    id: 'se_walk_women_001_1',
    file: 'se_walk_women_001_1.mp3',
    category: 'footsteps',
    description: '女性平稳走近脚步声（配合 walkIn 物理入场）',
    tags: ['walk', 'footsteps', 'women', 'walkin', 'enter'],
    defaultVolume: 0.9
  },
  {
    id: 'se_walk_women_002_1',
    file: 'se_walk_women_002_1.mp3',
    category: 'footsteps',
    description: '女性轻快走动 / 转身离开脚步声（walkOut 常用）',
    tags: ['walk', 'footsteps', 'women', 'walkout', 'leave'],
    defaultVolume: 0.85
  },
  {
    id: 'se_walk_men_001_1',
    file: 'se_walk_men_001_1.mp3',
    category: 'footsteps',
    description: '男性沉稳走近脚步声（配合 walkIn 物理入场）',
    tags: ['walk', 'footsteps', 'men', 'walkin', 'enter'],
    defaultVolume: 0.9
  },
  {
    id: 'se_run_women_001_1',
    file: 'se_run_women_001_1.mp3',
    category: 'running',
    description: '女性匆忙奔跑脚步声（赶来 / 跑开）',
    tags: ['run', 'footsteps', 'women', 'hurry', 'rush'],
    defaultVolume: 0.9
  },
  {
    id: 'se_run_men_001_1',
    file: 'se_run_men_001_1.mp3',
    category: 'running',
    description: '男性奔跑脚步声（赶来 / 跑开）',
    tags: ['run', 'footsteps', 'men', 'hurry', 'rush'],
    defaultVolume: 0.9
  },
  {
    id: 'se00043_b',
    file: 'se00043_b.mp3',
    category: 'door',
    description: '推门 / 拉门进入房间声',
    tags: ['door', 'open', 'enter', 'room', 'visit'],
    defaultVolume: 0.9
  },
  {
    id: 'se00044_b',
    file: 'se00044_b.mp3',
    category: 'door',
    description: '轻声关门 / 离开房间声',
    tags: ['door', 'close', 'leave', 'exit'],
    defaultVolume: 0.85
  },
  {
    id: 'se00001_b',
    file: 'se00001_b.mp3',
    category: 'door',
    description: '玄关门开关 / 出门声',
    tags: ['door', 'home', 'departure'],
    defaultVolume: 0.85
  },
  {
    id: 'se00004_b',
    file: 'se00004_b.mp3',
    category: 'phone',
    description: '手机收到消息通知提示音',
    tags: ['phone', 'message', 'notify', 'sms', 'line'],
    defaultVolume: 0.9
  },
  {
    id: 'se00183_b',
    file: 'se00183_b.mp3',
    category: 'phone',
    description: '手机解锁 / 点亮屏幕 / 通知操作音',
    tags: ['phone', 'tap', 'screen', 'notification'],
    defaultVolume: 0.85
  },
  {
    id: 'se00084_b',
    file: 'se00084_b.mp3',
    category: 'call',
    description: 'Nightcord / 语音通话接通提示音',
    tags: ['call', 'nightcord', 'mic', 'voice_call', 'online'],
    defaultVolume: 0.9
  },
  {
    id: 'se00098',
    file: 'se00098.mp3',
    category: 'call',
    description: '语音通话结束 / 静音挂断提示音',
    tags: ['call', 'hangup', 'mute', 'nightcord'],
    defaultVolume: 0.85
  },
  {
    id: 'se00055_b',
    file: 'se00055_b.mp3',
    category: 'cloth',
    description: '起身 / 拿取物品 / 衣物与背包窸窣声',
    tags: ['cloth', 'rustle', 'grab', 'bag', 'standup'],
    defaultVolume: 0.85
  },
  {
    id: 'se00122_b',
    file: 'se00122_b.mp3',
    category: 'paper',
    description: '翻动纸张 / 乐谱 / 速写本 / 日程表声',
    tags: ['paper', 'sheet', 'score', 'sketchbook', 'notebook'],
    defaultVolume: 0.85
  },
  {
    id: 'se00007_b',
    file: 'se00007_b.mp3',
    category: 'pc',
    description: '电脑键盘敲击 / 鼠标点击打开文件声',
    tags: ['keyboard', 'pc', 'mouse', 'click', 'computer'],
    defaultVolume: 0.85
  },
  {
    id: 'se00320_b',
    file: 'se00320_b.mp3',
    category: 'music_edit',
    description: '编曲软件操作 / 音轨试听切换声',
    tags: ['daw', 'compose', 'music', 'track'],
    defaultVolume: 0.85
  },
  {
    id: 'se00028_b',
    file: 'se00028_b.mp3',
    category: 'reaction',
    description: '惊觉 / 猛然回头 / 突然心惊声',
    tags: ['startle', 'surprise', 'shock', 'turn'],
    defaultVolume: 0.9
  },
  {
    id: 'se00034_b',
    file: 'se00034_b.mp3',
    category: 'crowd',
    description: '周围人群喧闹 / 会场人声环境音',
    tags: ['crowd', 'street', 'venue', 'live', 'school_hall'],
    defaultVolume: 0.75
  },
  {
    id: 'se00249_b',
    file: 'se00249_b.mp3',
    category: 'bell',
    description: '学校上下课铃声 / 校园钟声',
    tags: ['school', 'bell', 'chime', 'classroom'],
    defaultVolume: 0.85
  },
  {
    id: 'se00075_b',
    file: 'se00075_b.mp3',
    category: 'camera',
    description: '相机快门拍照声',
    tags: ['camera', 'photo', 'shutter'],
    defaultVolume: 0.9
  },
  {
    id: 'se00092_b',
    file: 'se00092_b.mp3',
    category: 'sekai',
    description: 'SEKAI 强光 / 世界异象闪烁声',
    tags: ['sekai', 'light', 'flash'],
    defaultVolume: 0.85
  },
  {
    id: 'se00097',
    file: 'se00097.mp3',
    category: 'pause',
    description: '脚步骤停 / 气氛凝滞轻响',
    tags: ['stop', 'hesitate', 'tension'],
    defaultVolume: 0.8
  }
]

const KEYWORD_SE_MAP: Array<[RegExp, string]> = [
  [/回忆|闪回|白光|flashback|memory/i, 'se00053_b'],
  [/门开|开门|门.*打开|打开门|推门|拉门|进屋|进门|敲门|door.*open/i, 'se00043_b'],
  [/关门|出门|带上门|door.*close/i, 'se00044_b'],
  [/奔跑|跑来|跑过|飞奔|冲进|run/i, 'se_run_women_001_1'],
  [/男.*走|走近.*男|男.*脚步|walk_men/i, 'se_walk_men_001_1'],
  [/走近|走来|脚步|walkin|walk/i, 'se_walk_women_001_1'],
  [/离开.*步|走远|walkout/i, 'se_walk_women_002_1'],
  [/语音|通话|连线|上线|麦克风|nightcord.*call|voice_call/i, 'se00084_b'],
  [/挂断|下线|静音|hangup/i, 'se00098'],
  [/消息|短信|通知|震动|提示音|notify|message/i, 'se00004_b'],
  [/手机|屏幕|点亮|phone|tap/i, 'se00183_b'],
  [/翻|纸|乐谱|曲谱|速写本|笔记本|本子|日程|paper|sketchbook|score/i, 'se00122_b'],
  [/编曲|音轨|demo|daw/i, 'se00320_b'],
  [/键盘|电脑|鼠标|点击|文件|keyboard|pc|click/i, 'se00007_b'],
  [/衣料|起身|拿|递|收拾|包|袋|cloth|grab|rustle/i, 'se00055_b'],
  [/铃声|上课铃|下课铃|钟声|bell|chime/i, 'se00249_b'],
  [/快门|拍照|相机|camera|shutter/i, 'se00075_b'],
  [/人群|嘈杂|喧闹|会场|热闹|crowd/i, 'se00034_b'],
  [/惊|吓|猛然|回头|一震|startle|shock/i, 'se00028_b'],
  [/停下|骤停|凝滞|stop/i, 'se00097'],
  [/sekai|世界.*光/i, 'se00092_b']
]

export function resolveScenarioSe(query: unknown): ScenarioSeCue | null {
  if (typeof query !== 'string') return null
  const raw = query.trim()
  if (!raw) return null
  const clean = raw
    .replace(/\\/g, '/')
    .replace(/^resources\//i, '')
    .replace(/^audio\/se\//i, '')
    .replace(/^cloud\//i, '')
  const lower = clean.toLowerCase()
  const stem = lower.replace(/\.(mp3|wav|ogg|flac|hca)$/i, '')

  for (const cue of CURATED_SCENARIO_SES) {
    if (
      cue.id.toLowerCase() === stem ||
      cue.file.toLowerCase() === lower ||
      cue.tags.some((tag) => tag.toLowerCase() === stem)
    ) {
      return cue
    }
  }
  for (const [pattern, cueId] of KEYWORD_SE_MAP) {
    if (pattern.test(raw)) {
      return CURATED_SCENARIO_SES.find((cue) => cue.id === cueId) ?? null
    }
  }
  return null
}

export function sePromptList(): string {
  return CURATED_SCENARIO_SES.map(
    (cue) => `- ${cue.file}（${cue.category}）：${cue.description}`
  ).join('\n')
}

export const CURATED_SCENARIO_EFFECTS = [
  'rain',
  'snow',
  'sakura',
  'sparkle',
  'speedlines',
  'memories',
  'bubble',
  'mist'
] as const

export type CuratedScenarioEffect = (typeof CURATED_SCENARIO_EFFECTS)[number]

export function normalizeScenarioEffectName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  if (/雨|rain/.test(lower)) return 'rain'
  if (/雪|snow/.test(lower)) return 'snow'
  if (/樱|桜|花瓣|sakura|petal/.test(lower)) return 'sakura'
  if (/集中|速度|dash|speed/.test(lower)) return 'speedlines'
  if (/回忆|回想|memor/.test(lower)) return 'memories'
  if (/泡|bubble/.test(lower)) return 'bubble'
  if (/雾|烟|mist|fog/.test(lower)) return 'mist'
  if (/星|闪|光|sparkle|kirakira/.test(lower)) return 'sparkle'
  return trimmed
}

const VIRTUAL_SINGER_KEYS = ['miku', 'hatsune', 'rin', 'len', 'luka', 'meiko', 'kaito', '初音', '镜音', '巡音']

export function isVirtualSingerModel(model: { id?: number; name?: string; shortName?: string; path?: string }): boolean {
  const haystack = `${model.name ?? ''} ${model.shortName ?? ''} ${model.path ?? ''}`.toLowerCase()
  if (VIRTUAL_SINGER_KEYS.some((key) => haystack.includes(key))) return true
  if (typeof model.id === 'number') {
    const base = model.id >= 1000 ? model.id - 1000 : model.id
    if (base >= 21 && base <= 26) return true
  }
  return false
}
