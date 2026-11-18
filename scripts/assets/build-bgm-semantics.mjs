#!/usr/bin/env node
/**
 * 生成全量 BGM 简体中文语义词典（src/host/assets/bgm-semantics.json）：
 * - 覆盖全部 ~400 首剧情 BGM (sound/scenario/bgm/) 与 ~21 首区域 BGM (sound/area_bgm/)；
 * - 结合 musicSoundTracks.json 曲名/分类 + 官方剧情 5,400+ 幕对白情绪/转场共现统计
 *   + 曲目编号/前缀规律，为每一首曲目生成可读中文名、情绪标签、节奏、适用场景与简洁指导描述。
 *
 * 用法：
 *   node scripts/assets/build-bgm-semantics.mjs --out src/host/assets/bgm-semantics.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_OUT = 'src/host/assets/bgm-semantics.json'
const DEFAULT_CACHE_DIR = 'cache/semantic-build'
const DEFAULT_CATALOG_CACHE = 'cache/moesekai/catalog.json'
const DEFAULT_CN_CORPUS = 'd:/Users/桌面/mzkbot/msst-ai-lab/corpus/raw/cn'
const STORAGE_ORIGIN = 'https://storage.exmeaning.com'
const JP_MASTER_BASE = 'https://cdn.jsdelivr.net/gh/Sekai-World/sekai-master-db-diff@master'

const CATEGORY_UNIT = {
  1: '通用',
  2: '虚拟歌手',
  3: 'Leo/need',
  4: 'MORE MORE JUMP!',
  5: 'Vivid BAD SQUAD',
  6: 'Wonderlands×Showtime',
  7: '25时，Nightcord de.',
  11: '通用',
  12: 'SEKAI',
  13: '剧情',
  14: '演出',
  15: '演出',
  16: '通用',
  20: '其他',
  30: '联动'
}

/** 21 首 sound/area_bgm/ 官方区域 BGM 简体中文语义表 */
const AREA_BGM_CURATED = {
  normal_area: {
    name: '涩谷街区日常主题曲',
    mood: '轻松日常',
    tempo: '中拍',
    category: '区域日常',
    unit: '通用',
    scenes: ['涩谷逛街', '日常散步', '轻松闲聊'],
    description: '轻松日常·中拍 | 涩谷现实街区通用主题曲，明快温和，适合逛街与日常开场'
  },
  leoneed_untitled: {
    name: '教室「世界」主题曲',
    mood: '温暖治愈',
    tempo: '中慢',
    category: 'SEKAI主题',
    unit: 'Leo/need',
    scenes: ['教室「世界」', '乐队谈心', '放学回忆'],
    description: '温暖治愈·中慢 | Leo/need 教室「世界」主题曲，带夕阳余韵与青春怀旧感'
  },
  leoneed_untitled_2: {
    name: '教室「世界」主题曲 II',
    mood: '温暖治愈',
    tempo: '中拍',
    category: 'SEKAI主题',
    unit: 'Leo/need',
    scenes: ['教室「世界」', '乐队排练', '希望前行'],
    description: '温暖治愈·中拍 | 教室「世界」新版主题曲，开朗清澈，适合团体讨论与积极推进'
  },
  bgm_area_leoneed_untitled_2: {
    name: '教室「世界」主题曲（区域版）',
    mood: '温暖治愈',
    tempo: '中拍',
    category: 'SEKAI主题',
    unit: 'Leo/need',
    scenes: ['教室「世界」', '乐队日常'],
    description: '温暖治愈·中拍 | 教室「世界」区域环境曲，适合 Leo/need 校园乐队日常'
  },
  moremore_untitled: {
    name: '舞台「世界」主题曲',
    mood: '元气欢快',
    tempo: '中快',
    category: 'SEKAI主题',
    unit: 'MORE MORE JUMP!',
    scenes: ['舞台「世界」', '偶像练习', '元气鼓励'],
    description: '元气欢快·中快 | MMJ 舞台「世界」主题曲，明亮偶像流行风格，适合活力与练习场景'
  },
  moremore_untitled_2: {
    name: '舞台「世界」主题曲 II',
    mood: '元气欢快',
    tempo: '中快',
    category: 'SEKAI主题',
    unit: 'MORE MORE JUMP!',
    scenes: ['舞台「世界」', '直播策划', '偶像聚会'],
    description: '元气欢快·中快 | 舞台「世界」新版主题曲，闪耀轻快，适合偶像日常与企划讨论'
  },
  bgm_area_moremore_untitled_2: {
    name: '舞台「世界」主题曲（区域版）',
    mood: '元气欢快',
    tempo: '中快',
    category: 'SEKAI主题',
    unit: 'MORE MORE JUMP!',
    scenes: ['舞台「世界」', '偶像日常'],
    description: '元气欢快·中快 | 舞台「世界」区域环境曲，清新明朗'
  },
  vividbad_untitled: {
    name: '街头「世界」主题曲',
    mood: '律动街头',
    tempo: '中快',
    category: 'SEKAI主题',
    unit: 'Vivid BAD SQUAD',
    scenes: ['街头「世界」', 'Crase Cafe', '音乐交流'],
    description: '律动街头·中快 | VBS 街头「世界」主题曲，都市节拍感强，适合咖啡厅与街头音乐话题'
  },
  vividbad_untitled_2: {
    name: '街头「世界」主题曲 II',
    mood: '律动街头',
    tempo: '中快',
    category: 'SEKAI主题',
    unit: 'Vivid BAD SQUAD',
    scenes: ['街头「世界」', '挑战目标', '街头排练'],
    description: '律动街头·中快 | 街头「世界」新版主题曲，节奏利落，适合立志与伙伴对谈'
  },
  wonderlands_untitled: {
    name: '奇幻乐园「世界」主题曲',
    mood: '奇幻活泼',
    tempo: '快板',
    category: 'SEKAI主题',
    unit: 'Wonderlands×Showtime',
    scenes: ['奇幻乐园「世界」', '剧团闹剧', '创意演出'],
    description: '奇幻活泼·快板 | WxS 奇幻乐园「世界」主题曲，马戏团般跳脱欢快，适合热闹排戏'
  },
  wonderlands_untitled_2: {
    name: '奇幻乐园「世界」主题曲 II',
    mood: '奇幻活泼',
    tempo: '快板',
    category: 'SEKAI主题',
    unit: 'Wonderlands×Showtime',
    scenes: ['奇幻乐园「世界」', 'Wonderhoy', '盛大演出'],
    description: '奇幻活泼·快板 | 奇幻乐园「世界」新版主题曲，充满梦想与剧场童话氛围'
  },
  nightcode_untitled: {
    name: '无人「世界」主题曲',
    mood: '宁静深夜',
    tempo: '慢板',
    category: 'SEKAI主题',
    unit: '25时，Nightcord de.',
    scenes: ['无人「世界」', '深夜独处', '内心独白'],
    description: '宁静深夜·慢板 | 25时 无人「世界」主题曲，空灵清冷，适合深夜对话、内省与温柔安慰'
  },
  nightcode_untitled_2: {
    name: '无人「世界」主题曲 II',
    mood: '宁静深夜',
    tempo: '慢板',
    category: 'SEKAI主题',
    unit: '25时，Nightcord de.',
    scenes: ['无人「世界」', '深夜心绪', '坦诚倾诉'],
    description: '宁静深夜·慢板 | 无人「世界」新版主题曲，静谧而带微光，适合夜晚深谈与情绪余韵'
  },
  bgm_area_wishtree: {
    name: '心愿之树「世界」主题曲',
    mood: '神秘空灵',
    tempo: '中慢',
    category: 'SEKAI主题',
    unit: '虚拟歌手',
    scenes: ['心愿之树', '世界交汇', '跨越成长'],
    description: '神秘空灵·中慢 | 心愿之树「世界」氛围曲，澄澈宏阔，适合心愿交流与重要转折'
  },
  bgm_area_bigtree: {
    name: '心愿巨树主题曲',
    mood: '神秘空灵',
    tempo: '中慢',
    category: 'SEKAI主题',
    unit: '虚拟歌手',
    scenes: ['心愿空间', '回忆交汇'],
    description: '神秘空灵·中慢 | 巨树主题环境曲，适合异世界探索与静谧思索'
  },
  bgm_area_movie_2025: {
    name: '剧场版「世界」主题曲',
    mood: '神秘空灵',
    tempo: '中慢',
    category: '特别活动',
    unit: '虚拟歌手',
    scenes: ['剧场版「世界」', '相遇与歌声'],
    description: '神秘空灵·中慢 | 2025 剧场版特别「世界」氛围曲，适合特别篇与跨越时空的对话'
  },
  bgm_area_e_collabo: {
    name: '特别联动区域主题曲',
    mood: '奇幻活泼',
    tempo: '中快',
    category: '特别活动',
    unit: '联动',
    scenes: ['特别活动', '联动舞台'],
    description: '奇幻活泼·中快 | 特别联动活动区域主题曲，节奏鲜明轻快'
  },
  bgm_area_aprilfool_2022: {
    name: '愚人节特别区域主题曲',
    mood: '奇幻活泼',
    tempo: '中快',
    category: '特别活动',
    unit: '通用',
    scenes: ['愚人节', '轻松整活', '跨团互动'],
    description: '奇幻活泼·中快 | 愚人节限定区域主题曲，适合轻松搞怪与跨团聚会'
  },
  bgm_april_fool_2026: {
    name: '愚人节 2026 特别主题曲',
    mood: '奇幻活泼',
    tempo: '快板',
    category: '特别活动',
    unit: '通用',
    scenes: ['愚人节', '奇幻闹剧'],
    description: '奇幻活泼·快板 | 2026 愚人节限定主题曲，适合脑洞与喜剧场景'
  },
  collaboration_akuno: {
    name: '恶之大罪联动「世界」主题曲',
    mood: '神秘空灵',
    tempo: '慢板',
    category: '特别活动',
    unit: '联动',
    scenes: ['古典宫廷', '命运叙事', '联动剧场'],
    description: '神秘空灵·慢板 | 恶之大罪联动区域曲，带有古典歌剧般的宿命与庄严感'
  },
  collaboration_sanrio: {
    name: '三丽鸥联动「世界」主题曲',
    mood: '元气欢快',
    tempo: '中快',
    category: '特别活动',
    unit: '联动',
    scenes: ['可爱互动', '游园聚会', '轻松日常'],
    description: '元气欢快·中快 | 三丽鸥联动可爱主题曲，甜美轻快，适合治愈互动'
  }
}

/** 高频核心剧情 BGM 的精确中文标注（覆盖无官方曲名/重点曲目 + 校准情绪） */
const CURATED_SCENARIO_BGM = {
  bgm00001: { name: '街头律动序曲', mood: '律动街头', tempo: '中快', category: '街头日常', unit: 'Vivid BAD SQUAD', description: '律动街头·中快 | 明快有节奏感的都市开场曲，适合街头练习与伙伴碰面' },
  bgm00002: { name: '青春校园微风', mood: '轻松日常', tempo: '中拍', category: '校园日常', unit: 'Leo/need', description: '轻松日常·中拍 | 清新温和的校园日常曲，适合课间聊天与放学时光' },
  bgm00003: { name: 'Slapstick!!', mood: '元气欢快', tempo: '快板', category: '日常喜剧', unit: '通用', description: '元气欢快·快板 | 活泼俏皮的闹剧喜剧 BGM，适合吐槽、热闹拌嘴与开心互动' },
  bgm00004: { name: '奇幻剧场进行曲', mood: '奇幻活泼', tempo: '快板', category: '演出排练', unit: 'Wonderlands×Showtime', description: '奇幻活泼·快板 | 剧团彩排与奇思妙想专用欢快曲，充满舞台张力' },
  bgm00005: { name: '夜色微光（25时）', mood: '宁静深夜', tempo: '慢板', category: '深夜叙事', unit: '25时，Nightcord de.', description: '宁静深夜·慢板 | 安静而略带忧思的夜晚钢琴与电子氛围曲，适合深夜通话与倾诉' },
  bgm00006: { name: '微笑的暖阳', mood: '温暖治愈', tempo: '中慢', category: '温情日常', unit: '通用', description: '温暖治愈·中慢 | 柔和阳光般的日常舒缓 BGM，适合温柔谈心、解开心结与日常相处' },
  bgm00007: { name: '心弦悸动', mood: '温暖治愈', tempo: '中慢', category: '抒情回忆', unit: '通用', description: '温暖治愈·中慢 | 细腻感人的钢琴抒情曲，适合回忆往事、真诚表露心意' },
  bgm00008: { name: '偶像闪耀步伐', mood: '元气欢快', tempo: '中快', category: '偶像日常', unit: 'MORE MORE JUMP!', description: '元气欢快·中快 | 偶像练习与元气日常曲，明亮积极' },
  bgm00009: { name: '潜藏的不安', mood: '紧张悬疑', tempo: '中慢', category: '情绪波澜', unit: '通用', description: '紧张悬疑·中慢 | 气氛突然沉下来的不安压迫感 BGM，适合矛盾爆发前或坏消息来临' },
  bgm00010: { name: '追逐梦想的脚步', mood: '热血激昂', tempo: '中快', category: '激励成长', unit: '通用', description: '热血激昂·中快 | 坚定决意与迈向前方的鼓舞曲，适合下定决心与振作时刻' },
  bgm00016: { name: '泪水顺心而下', mood: '感伤忧郁', tempo: '慢板', category: '催泪抒情', unit: '通用', description: '感伤忧郁·慢板 | 弦乐与钢琴交织的深情悲伤曲，适合伤心落泪、痛苦挣扎与坦白脆弱' },
  bgm00017: { name: '心意一定能传达…', mood: '温暖治愈', tempo: '慢板', category: '感动收束', unit: '通用', description: '温暖治愈·慢板 | 柔和而满怀希望的抒情曲，适合情绪释放后的温柔和解' },
  bgm00018: { name: '此刻眼前的日常', mood: '轻松日常', tempo: '中拍', category: '日常聊天', unit: '通用', description: '轻松日常·中拍 | 最百搭的平和平稳日常对话 BGM，不抢台词风头' },
  bgm00020: { name: '雀跃的季节', mood: '元气欢快', tempo: '中快', category: '明快日常', unit: '通用', description: '元气欢快·中快 | 轻盈愉快的日常节拍，适合出游计划、期待与分享喜悦' },
  bgm00021: { name: '静谧日常絮语', mood: '轻松日常', tempo: '中慢', category: '日常谈心', unit: '通用', description: '轻松日常·中慢 | 高频剧情平缓过渡曲，安静自然，适合室内交谈与思索' },
  bgm00024: { name: '温柔星霜', mood: '温暖治愈', tempo: '慢板', category: '温情回忆', unit: 'Leo/need', description: '温暖治愈·慢板 | 极具代表性的温柔吉他/钢琴抒情曲，适合青春回忆、夜晚谈心与深厚羁绊' },
  bgm00032: { name: '黄昏的游行', mood: '奇幻活泼', tempo: '中快', category: '黄昏剧场', unit: 'Wonderlands×Showtime', description: '奇幻活泼·中快 | 带一点落日余晖与梦想气息的 WxS 舞台曲，适合排练收尾与梦想对谈' },
  bgm00034: { name: '街角沉思时刻', mood: '感伤忧郁', tempo: '中慢', category: '低落思索', unit: '通用', description: '感伤忧郁·中慢 | 适合独自思考、自我怀疑或沉默对视时的低落氛围曲' },
  bgm00038: { name: '紧绷的琴弦', mood: '紧张悬疑', tempo: '中快', category: '冲突危机', unit: '通用', description: '紧张悬疑·中快 | 急促紧张的冲突推进曲，适合争执、突发状况或焦急赶路' },
  bgm00039: { name: '暗涌的焦虑', mood: '紧张悬疑', tempo: '中慢', category: '凝重对峙', unit: '通用', description: '紧张悬疑·中慢 | 压抑沉重的低音氛围曲，适合犹豫挣扎、误解或秘密揭开前' },
  bgm00048: { name: '迈向光芒照耀的未来', mood: '热血激昂', tempo: '中快', category: '希望高潮', unit: '通用', description: '热血激昂·中快 | 明亮振奋的突破感配乐，适合跨越困难、共同约定未来' },
  bgm00055: { name: '深邃的凝望', mood: '宁静深夜', tempo: '慢板', category: '内心独白', unit: '通用', description: '宁静深夜·慢板 | 沉静克制的低语氛围曲，适合严肃对话、内心独白与认真探讨' },
  bgm00170: { name: '平凡时光 (Ordinary Time)', mood: '轻松日常', tempo: '中拍', category: '日常闲聊', unit: '通用', description: '轻松日常·中拍 | 现代清爽的日常对话配乐，适合咖啡厅、客厅与放学聊日常' },
  bgm00171: { name: '共享这份温暖', mood: '温暖治愈', tempo: '慢板', category: '温情治愈', unit: '通用', description: '温暖治愈·慢板 | 柔和安抚人心的日常抒情曲，适合彼此鼓励与体贴关怀' },
  bgm00173: { name: '沉入深处 (into deep)', mood: '宁静深夜', tempo: '慢板', category: '深沉内省', unit: '通用', description: '宁静深夜·慢板 | 深邃寂静的氛围音乐，适合深夜独处、创伤回忆或陷入沉思' },
  bgm00175: { name: '昔日之影', mood: '感伤忧郁', tempo: '慢板', category: '回忆往昔', unit: '通用', description: '感伤忧郁·慢板 | 带着淡淡遗憾的怀旧曲，适合回忆过去、物是人非之感' },
  bgm00180: { name: '宁静的归途', mood: '温暖治愈', tempo: '中慢', category: '放学黄昏', unit: '通用', description: '温暖治愈·中慢 | 夕阳西下并肩回家的平和配乐，适合黄昏街道或天台谈心' },
  bgm00190: { name: '快乐玩具进行曲', mood: '奇幻活泼', tempo: '快板', category: '喜剧玩闹', unit: 'Wonderlands×Showtime', description: '奇幻活泼·快板 | 俏皮跳跃的玩具箱节奏，适合笑梦整活、奇思妙想与轻喜剧' },
  bgm00215: { name: '殷切的心意', mood: '感伤忧郁', tempo: '慢板', category: '真情流露', unit: '通用', description: '感伤忧郁·慢板 | 诚挚而略带苦涩的情感配乐，适合倾诉烦恼与彼此理解' },
  '01_an_02': { name: '白石杏角色主题变奏曲', mood: '律动街头', tempo: '中快', category: '角色主题', unit: 'Vivid BAD SQUAD', description: '律动街头·中快 | 白石杏相关个人剧情曲，充满热情与街头活力' },
  '02_haruka_02': { name: '桐谷遥角色主题变奏曲', mood: '温暖治愈', tempo: '中拍', category: '角色主题', unit: 'MORE MORE JUMP!', description: '温暖治愈·中拍 | 桐谷遥相关个人剧情曲，沉稳温柔又带有偶像的坚定' }
}

const CHAR_SHORT_BY_PREFIX = {
  '01': '一歌', '02': '咲希', '03': '穗波', '04': '志步',
  '05': '实乃理', '06': '遥', '07': '爱莉', '08': '雫',
  '09': '心羽', '10': '杏', '11': '彰人', '12': '冬弥',
  '13': '司', '14': '笑梦', '15': '宁宁', '16': '类',
  '17': '奏', '18': '真冬', '19': '绘名', '20': '瑞希',
  '21': '初音未来', '22': '镜音铃', '23': '镜音连', '24': '巡音流歌',
  '25': 'MEIKO', '26': 'KAITO'
}

function unitFromCostume(costume) {
  const m = /^(?:v2_)?(\d{2})/.exec(String(costume || ''))
  if (!m) return ''
  const id = Number(m[1])
  if (id >= 1 && id <= 4) return 'Leo/need'
  if (id >= 5 && id <= 8) return 'MORE MORE JUMP!'
  if (id >= 9 && id <= 12) return 'Vivid BAD SQUAD'
  if (id >= 13 && id <= 16) return 'Wonderlands×Showtime'
  if (id >= 17 && id <= 20) return '25时，Nightcord de.'
  if (id >= 21 && id <= 26) return '虚拟歌手'
  return ''
}

function readJsonDir(dir) {
  if (!dir || !fs.existsSync(dir)) return []
  const out = []
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue
    try {
      out.push({ file: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) })
    } catch {
      // ignore
    }
  }
  return out
}

function inferMoodFromProfile({ title, catUnit, stats, id }) {
  const hay = `${title} ${id}`.toLowerCase()
  const { sad = 0, tense = 0, happy = 0, calm = 0, night = 0, flashback = 0, shake = 0, count = 0 } = stats || {}

  // 1. 曲名关键词优先
  if (/slapstick|happy|smile|march|fun|pop|ウキウキ|笑顔|パレード|ワクワク|おひさま|陽気|にぎやか|ドタバタ/i.test(title)) {
    return { mood: '元气欢快', tempo: '快板', category: '欢快日常' }
  }
  if (/deep|dark|night|shadow|abyss|void|心景|深き|静寂|迷い|孤独|深夜/i.test(title)) {
    return { mood: '宁静深夜', tempo: '慢板', category: '深夜思索' }
  }
  if (/tear|sad|cry|sorrow|pain|涙|切な|悲|在りし日|別れ|寂し/i.test(title)) {
    return { mood: '感伤忧郁', tempo: '慢板', category: '催泪抒情' }
  }
  if (/tension|crisis|thread|panic|張りつめ|緊迫|焦り|不安|対峙|危機|嵐/i.test(title)) {
    return { mood: '紧张悬疑', tempo: '中快', category: '冲突危机' }
  }
  if (/future|hope|shine|dream|bright|光射す|未来|希望|決意|勇気|翔/i.test(title)) {
    return { mood: '热血激昂', tempo: '中快', category: '激励成长' }
  }
  if (/warm|gentle|ordinary|home|帰り道|ぬくもり|微笑|陽だまり|優し|穏やか|日常|星霜|想い/i.test(title)) {
    return { mood: '温暖治愈', tempo: '中慢', category: '温情日常' }
  }
  if (/sekai|wish|tree|miracle|世界|セカイ|星/i.test(hay)) {
    return { mood: '神秘空灵', tempo: '中慢', category: 'SEKAI氛围' }
  }

  // 2. 剧情共现统计分类
  if (count > 0) {
    if (tense + shake * 2 >= Math.max(3, count * 0.45) && tense >= sad) {
      return { mood: '紧张悬疑', tempo: '中快', category: '剧情张力' }
    }
    if (sad + flashback >= Math.max(3, count * 0.4) && sad >= happy) {
      return { mood: '感伤忧郁', tempo: '慢板', category: '抒情回忆' }
    }
    if (night >= Math.max(3, count * 0.45) || catUnit === '25时，Nightcord de.') {
      return { mood: '宁静深夜', tempo: '慢板', category: '夜晚谈心' }
    }
    if (happy >= Math.max(3, count * 0.45) || catUnit === 'Wonderlands×Showtime' || catUnit === 'MORE MORE JUMP!') {
      return { mood: '元气欢快', tempo: '中快', category: '欢快互动' }
    }
    if (calm >= sad && calm >= tense) {
      return { mood: '温暖治愈', tempo: '中慢', category: '温情日常' }
    }
  }

  // 3. 兜底分类（按编号与所属团队）
  if (id.startsWith('bgm10')) {
    return { mood: '神秘空灵', tempo: '中慢', category: '特别剧情' }
  }
  if (id.startsWith('bgm90')) {
    return { mood: '热血激昂', tempo: '中快', category: '演出高潮' }
  }
  if (catUnit === 'Wonderlands×Showtime') return { mood: '奇幻活泼', tempo: '快板', category: '剧团日常' }
  if (catUnit === '25时，Nightcord de.') return { mood: '宁静深夜', tempo: '慢板', category: '深夜叙事' }
  if (catUnit === 'Vivid BAD SQUAD') return { mood: '律动街头', tempo: '中快', category: '街头音乐' }
  if (catUnit === 'MORE MORE JUMP!') return { mood: '元气欢快', tempo: '中快', category: '偶像日常' }
  if (catUnit === 'Leo/need') return { mood: '温暖治愈', tempo: '中慢', category: '校园青春' }
  return { mood: '轻松日常', tempo: '中拍', category: '剧情通用' }
}

const MOOD_GUIDANCE = {
  轻松日常: '平稳轻快的日常对话配乐，适合课间、客厅、街头闲聊与开场铺垫',
  温暖治愈: '温柔舒缓的情感叙事配乐，适合谈心、安慰、回忆与和解时刻',
  感伤忧郁: '深沉细腻的抒情伤感配乐，适合低落倾诉、过往伤痛与真情流露',
  紧张悬疑: '紧绷压迫的转折冲突配乐，适合误会争执、危机推进与心绪焦灼',
  热血激昂: '明亮振奋的鼓舞向前配乐，适合立下约定、团队鼓劲与高潮突破',
  元气欢快: '活泼跳脱的喜剧明快配乐，适合热闹聚会、吐槽拌嘴与开心互动',
  奇幻活泼: '剧场童话般的灵动配乐，适合排戏、游乐园与充满想象力的互动',
  律动街头: '节奏鲜明的都市潮流配乐，适合街头练习、Livehouse 与音乐讨论',
  宁静深夜: '清冷静谧的夜晚独处配乐，适合深夜对话、25时连线与内心独白',
  神秘空灵: '澄澈空灵的异世界氛围曲，适合 SEKAI 异象、星光与心愿交流'
}

export async function buildBgmSemantics(options = {}) {
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR
  const catalogCache = options.catalogCache || DEFAULT_CATALOG_CACHE

  let scenarioBgmIds = []
  let areaBgmIds = Object.keys(AREA_BGM_CURATED)
  if (fs.existsSync(catalogCache)) {
    try {
      const cat = JSON.parse(fs.readFileSync(catalogCache, 'utf-8'))
      if (Array.isArray(cat.bgm)) {
        scenarioBgmIds = cat.bgm.map((b) => b.id).filter(Boolean)
      }
    } catch {
      // ignore
    }
  }
  if (scenarioBgmIds.length === 0) {
    // 联网列举 scenario/bgm/ 与 area_bgm/
    const listPrefix = async (prefix) => {
      const out = []
      let cursor = null
      do {
        const q = new URLSearchParams({ server: 'jp', prefix, limit: '200' })
        if (cursor) q.set('cursor', cursor)
        const page = await fetch(`${STORAGE_ORIGIN}/api/assets/bundles?${q}`).then((r) => r.json())
        for (const item of page.items || []) {
          if (item.type === 'bundle' && item.name && item.name !== 'bgm' && item.name !== 'bgm00000') {
            out.push(item.name)
          }
        }
        cursor = page.nextCursor?.trim() || null
      } while (cursor)
      return out
    }
    scenarioBgmIds = await listPrefix('sound/scenario/bgm/')
    const remoteArea = await listPrefix('sound/area_bgm/').catch(() => [])
    if (remoteArea.length > 0) areaBgmIds = remoteArea
  }

  // 读取 musicSoundTracks
  const readCached = (name) => {
    const p = path.join(cacheDir, name)
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null
  }
  const jpTracks =
    readCached('musicSoundTracks_jp.json') ??
    (await fetch(`${JP_MASTER_BASE}/musicSoundTracks.json`).then((r) => r.json()).catch(() => []))

  const trackByFile = new Map()
  for (const t of jpTracks) {
    const key = String(t.assetbundleFileName || '').trim()
    if (!key) continue
    if (!trackByFile.has(key)) trackByFile.set(key, { titles: [], categoryIds: [] })
    const rec = trackByFile.get(key)
    if (t.title && !rec.titles.includes(t.title)) rec.titles.push(t.title)
    if (t.musicSoundTrackCategoryId && !rec.categoryIds.includes(Number(t.musicSoundTrackCategoryId))) {
      rec.categoryIds.push(Number(t.musicSoundTrackCategoryId))
    }
  }

  // 扫描语料统计情绪/场景共现
  const scenarios = [
    ...readJsonDir(DEFAULT_CN_CORPUS),
    ...readJsonDir(path.join(cacheDir, 'cn_events')),
    ...readJsonDir(path.join(cacheDir, 'cn_stories')),
    ...readJsonDir(path.join(cacheDir, 'jp_new_stories'))
  ]

  const stats = new Map()
  const getStat = (id) => {
    if (!stats.has(id)) {
      stats.set(id, { count: 0, sad: 0, tense: 0, happy: 0, calm: 0, night: 0, flashback: 0, shake: 0, units: new Map() })
    }
    return stats.get(id)
  }

  for (const entry of scenarios) {
    const s = entry.data
    if (!s || typeof s !== 'object') continue
    const units = (s.AppearCharacters || []).map((c) => unitFromCostume(c.CostumeType)).filter(Boolean)
    let curBgm = s.FirstBgm && s.FirstBgm !== 'bgm00000' ? s.FirstBgm : ''
    if (curBgm) {
      const st = getStat(curBgm)
      st.count += 1
      for (const u of units) st.units.set(u, (st.units.get(u) || 0) + 1)
    }

    for (const sn of s.Snippets || []) {
      if (sn.Action === 7) {
        const sd = (s.SoundData || [])[sn.ReferenceIndex] || {}
        if (sd.Bgm) {
          curBgm = sd.Bgm === 'bgm00000' ? '' : sd.Bgm
          if (curBgm) {
            const st = getStat(curBgm)
            st.count += 1
            for (const u of units) st.units.set(u, (st.units.get(u) || 0) + 1)
          }
        }
      } else if (sn.Action === 6 && curBgm) {
        const ef = (s.SpecialEffectData || [])[sn.ReferenceIndex] || {}
        const st = getStat(curBgm)
        if (ef.EffectType === 9 || ef.EffectType === 10) st.flashback += 1
        if (ef.EffectType === 11 || ef.EffectType === 12) st.shake += 1
      } else if (sn.Action === 1 && curBgm) {
        const td = (s.TalkData || [])[sn.ReferenceIndex]
        const body = String(td?.Body || '')
        if (!body) continue
        const st = getStat(curBgm)
        if (/难过|伤心|哭|泪|痛|对不起|抱歉|寂寞|痛苦|悲|后悔/.test(body)) st.sad += 1
        if (/糟了|怎么办|怎么会|难道|吵|生气|别这样|急|危险|骗人|不甘/.test(body)) st.tense += 1
        if (/哈哈|太好了|开心|期待|笑|棒|♪|！|Wonderhoy|加油|厉害/.test(body)) st.happy += 1
        if (/深夜|25点|这么晚|睡|晚安|安静|夜晚/.test(body)) st.night += 1
        if (/嗯|谢谢|温柔|平时|日常|一起|慢慢/.test(body)) st.calm += 1
      }
    }
  }

  const tracks = {}
  const allIds = [...new Set([...scenarioBgmIds, ...areaBgmIds])].sort()

  for (const id of allIds) {
    const isArea = areaBgmIds.includes(id)
    if (AREA_BGM_CURATED[id]) {
      tracks[id] = {
        ...AREA_BGM_CURATED[id],
        bundlePrefix: isArea ? 'sound/area_bgm/' : 'sound/scenario/bgm/',
        tags: [AREA_BGM_CURATED[id].mood, AREA_BGM_CURATED[id].tempo, AREA_BGM_CURATED[id].category, AREA_BGM_CURATED[id].unit].filter(Boolean)
      }
      continue
    }

    const baseId = id.replace(/_\d+$/, '')
    const curated = CURATED_SCENARIO_BGM[id] || CURATED_SCENARIO_BGM[baseId]
    const trackInfo = trackByFile.get(id) || trackByFile.get(baseId)
    const st = stats.get(id) || stats.get(baseId)
    const topUnit = st && st.units.size > 0
      ? [...st.units.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : '通用'
    const trackCategoryName = trackInfo?.categoryIds?.[0] ? CATEGORY_UNIT[trackInfo.categoryIds[0]] || '剧情' : ''
    const unit = curated?.unit || (trackCategoryName && trackCategoryName !== '剧情' ? trackCategoryName : topUnit)
    const rawTitle = trackInfo?.titles?.slice(0, 2).join(' / ') || ''

    if (curated) {
      const name = rawTitle && !curated.name ? rawTitle : curated.name
      const isVariant = id !== baseId && !CURATED_SCENARIO_BGM[id]
      tracks[id] = {
        name: isVariant ? `${name}（变奏版）` : name,
        category: curated.category,
        mood: curated.mood,
        tempo: curated.tempo,
        unit,
        scenes: [curated.category, curated.mood],
        description: curated.description,
        bundlePrefix: 'sound/scenario/bgm/',
        tags: [curated.mood, curated.tempo, curated.category, unit].filter(Boolean)
      }
      continue
    }

    const inferred = inferMoodFromProfile({ title: rawTitle, catUnit: unit, stats: st, id })
    const fallbackCnName =
      rawTitle ||
      `${inferred.category}·${inferred.mood}${unit && unit !== '通用' ? `（${unit}）` : ''} (${id})`
    const guidance = MOOD_GUIDANCE[inferred.mood] || MOOD_GUIDANCE['轻松日常']
    const unitHint = unit && unit !== '通用' ? `，常见于 ${unit} 剧情` : ''

    tracks[id] = {
      name: fallbackCnName,
      category: inferred.category,
      mood: inferred.mood,
      tempo: inferred.tempo,
      unit,
      scenes: [inferred.category, inferred.mood],
      description: `${inferred.mood}·${inferred.tempo} | ${guidance}${unitHint}`,
      bundlePrefix: isArea ? 'sound/area_bgm/' : 'sound/scenario/bgm/',
      tags: [inferred.mood, inferred.tempo, inferred.category, unit].filter(Boolean)
    }
  }

  return { tracks, scenarioCount: scenarios.length }
}

async function main() {
  const args = process.argv.slice(2)
  let out = DEFAULT_OUT
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = args[++i]
  }
  const { tracks, scenarioCount } = await buildBgmSemantics()
  const payload = {
    format: 'msst.bgm-semantics/1',
    generatedAt: new Date().toISOString(),
    source: `soundtracks+corpus:${scenarioCount}scenarios`,
    tracks
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  console.log(`wrote ${Object.keys(tracks).length} BGM semantic entries to ${out}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
