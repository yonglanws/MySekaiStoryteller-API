#!/usr/bin/env node
/**
 * 生成全量背景简体中文语义索引（src/host/assets/background-names.json）：
 * - 修复 EffectType === 8 (ScenarioTelop) 与 EffectType === 18 (PlaceInfo) 混淆，
 *   PlaceInfo 权重高于 Telop，且过滤「文化祭当日」「几天后」「25点」等纯时间/日期/日程标题；
 * - 优先从简体中文剧情语料（`MSS_CN_CORPUS_DIR` / `--corpus`、storage.exmeaning.com server=cn
 *   活动/主线/特别/区域对话）、sekai-master-db-cn-diff/areas.json、事件/角色共现提取语义；
 * - 对同地点多时段/光照变体保留独立标签（timeOfDay: 白天/黄昏/夜晚/深夜/通用，indoor: 室内/室外），
 *   并通过同源前缀继承、活动/角色共现、结构前缀规则覆盖全量 ~1,389 张云端背景。
 *
 * 用法：
 *   node scripts/assets/build-background-names.mjs --out src/host/assets/background-names.json
 *   node scripts/assets/build-background-names.mjs --corpus <dir1> --corpus <dir2> --out <file>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_OUT = 'src/host/assets/background-names.json'
const DEFAULT_CN_CORPUS = process.env.MSS_CN_CORPUS_DIR || ''
const DEFAULT_CACHE_DIR = 'cache/semantic-build'
const DEFAULT_CATALOG_CACHE = 'cache/moesekai/catalog.json'
const STORAGE_ORIGIN = 'https://storage.pjsk.moe'
const STORAGE_BACKUP_ORIGIN = 'https://storage.exmeaning.com'
const CN_MASTER_BASE = 'https://metadata.pjsk.moe/cn/master'
const JP_MASTER_BASE = 'https://metadata.pjsk.moe/jp/master'

/** 纯时间 / 日期 / 节庆当日等 ScenarioTelop 文本，绝不作为地点名。 */
export const NON_LOCATION_TELOP = new RegExp(
  [
    // 日文时间/日期
    '^(翌日|数日後|数時間後|数分後|数週間後|数ヶ月後|数年前|その日|次の日|同日|翌朝|翌晩|朝|昼|夜|夕方|深夜|早朝|[0-9０-９]+日目|[0-9０-９]+日後|[0-9０-９]+時間後)$',
    '^(.*後|.*前|.*時)$',
    '^(土曜日|日曜日|月曜日|火曜日|水曜日|木曜日|金曜日|年末|年始|平日|休日)$',
    // 中文时间/日期/相对时间
    '^[一二三四五六七八九十百千万两几半数0-9０-９]+\\s*(秒|分钟|分|小时|个小时|天|日|周|星期|礼拜|个月|月|年)\\s*(后|前|以后|之后|以前|之前)?$',
    '^(第二天|次日|同一天|当天|当日|当晚|前一天|前日|后一天|几天后|几天前|几小时后|几分钟后|几个月后|几个月前|几年前|十几年前|一年后|一个月后|一段时间后|不久后|片刻后|数分钟后|数十分钟后|数小时后|数日后|又过了|临近|与此同时).*$',
    '^(早上|早晨|清晨|上午|中午|午后|午休|下午|傍晚|傍晚时分|黄昏|放学后|晚上|夜晚|深夜|凌晨|半夜|25点|已过25点|25点过后).*$',
    '^(星期[一二三四五六日天]|礼拜[一二三四五六日天]|周[一二三四五六日天]|周末|平日|假日|休息日|某天|那天|今天|昨天|明天|年末|年始|正月|元旦).*$',
    // 活动/节庆/演出时间标记（例如「文化祭当日」「白色情人节当天」「拍摄当天」「正式演出前一天」「补习最后一天」）
    '^.*?(当日|当天|前日|前一天|前夜|后一天|最后一天|当晚|结束后|开始前|前几天|那几天|那天晚上|当天晚上|当天早上|的前一天|的后一天|前夕)$',
    '^(文化祭|文化节|白色情人节|情人节|圣诞节?|万圣节|新年|七夕|花火大会|运动会|体育祭|修学旅行|合宿|拍摄|彩排|排练|正式演出|演出|Live|公演|比赛|预选|决赛|二次審査|最终审|考试|期中|期末|毕业典礼|开学典礼|补习|练习).*?(后|前|次日|早上|晚上)?$'
  ].join('|'),
  'i'
)

const PLACEHOLDER = /^[?？…—\s]+$/

/** 常见日文/繁体地点词到简体中文的规范化映射（保留专有名词） */
const JP_TO_CN_PLACE = [
  ['３年Ａ組', '三年一班'],
  ['3年A組', '三年一班'],
  ['３年Ｂ組', '三年二班'],
  ['3年B組', '三年二班'],
  ['２年Ａ組', '二年一班'],
  ['2年A組', '二年一班'],
  ['２年Ｂ組', '二年二班'],
  ['2年B組', '二年二班'],
  ['１年Ａ組', '一年一班'],
  ['1年A組', '一年一班'],
  ['１年Ｂ組', '一年二班'],
  ['1年B組', '一年二班'],
  ['１年Ｃ組', '一年三班'],
  ['1年C組', '一年三班'],
  ['宮益坂女子学園', '宫益坂女子学园'],
  ['神山高校', '神山高校'],
  ['スクランブル交差点', '全向十字路口'],
  ['フェニックスワンダーランド', '菲尼克斯奇幻乐园'],
  ['ワンダーステージ', '奇幻舞台'],
  ['ファミリーレストラン', '家庭餐厅'],
  ['ショッピングモール', '购物中心'],
  ['スタジオ', '录音室'],
  ['レッスン場', '排练室'],
  ['レッスンスタジオ', '排练室'],
  ['レッスン', '练习'],
  ['誰もいないセカイ', '无人「世界」'],
  ['教室のセカイ', '教室「世界」'],
  ['ステージのセカイ', '舞台「世界」'],
  ['ストリートのセカイ', '街头「世界」'],
  ['ワンダーランドのセカイ', '奇幻乐园「世界」'],
  ['大樹のセカイ', '大树「世界」'],
  ['？？？のセカイ', '？？？「世界」'],
  ['準決勝 ライブステージ', '半决赛 Live 舞台'],
  ['ライブステージ', 'Live 舞台'],
  ['バス車内', '巴士车内'],
  ['アークランド', '方舟乐园'],
  ['とある村', '某村庄'],
  ['東京ファッション造形学院', '东京时尚造型学院'],
  ['展示スペース', '展示空间'],
  ['ソリス・レコード事務所', 'Solis 唱片事务所'],
  ['神山通り', '神山大街'],
  ['個展会場', '个展会场'],
  ['モアモアハウス', 'MORE MORE HOUSE'],
  ['ゲームセンター', '游戏厅'],
  ['海辺', '海边'],
  ['屋上', '天台'],
  ['校舎裏', '教学楼后'],
  ['中庭', '中庭'],
  ['住宅街', '住宅区'],
  ['病院', '医院'],
  ['病室', '病房'],
  ['駅', '车站'],
  ['駅前', '车站前'],
  ['喫茶店', '咖啡店'],
  ['楽屋', '休息室'],
  ['リビング', '客厅'],
  ['キッチン', '厨房'],
  ['図書館', '图书馆'],
  ['神社', '神社'],
  ['公園', '公园'],
  ['部屋', '房间'],
  ['の', '的']
]

/** 已知高价值基础场景词典（兜底/修正语料缺失或仅有特殊屏显的条目） */
const CURATED_BG_NAMES = {
  bg_white: {
    name: '纯白过渡幕布',
    category: '特效与纯色',
    timeOfDay: '通用',
    indoor: '室内',
    tags: ['白屏', '转场', '纯色', '回忆']
  },
  bg_a000000: {
    name: '纯黑过渡幕布',
    category: '特效与纯色',
    timeOfDay: '通用',
    indoor: '室内',
    tags: ['黑屏', '转场', '纯色']
  },
  bg_a000007: {
    name: '柔和浅色氛围幕布',
    category: '特效与纯色',
    timeOfDay: '通用',
    indoor: '室外',
    tags: ['纯色', '回忆', '氛围']
  },
  bg_a000025: {
    name: '暗夜静谧渐变幕布',
    category: '特效与纯色',
    timeOfDay: '深夜',
    indoor: '室内',
    tags: ['暗色', '回忆', '氛围']
  },
  bg_a000101: {
    name: '神山高校 中庭',
    category: '校园',
    timeOfDay: '白天',
    indoor: '室外',
    tags: ['神山高校', '中庭', '校园', '白天', '室外']
  },
  bg_a000105: {
    name: '神山高校 中庭（文化祭）',
    category: '校园',
    timeOfDay: '白天',
    indoor: '室外',
    tags: ['神山高校', '中庭', '文化祭', '校园']
  },
  bg_a000301: {
    name: '神山高校 三年一班',
    category: '校园',
    timeOfDay: '白天',
    indoor: '室内',
    tags: ['神山高校', '教室', '三年一班', '校园', '白天', '室内']
  },
  bg_a000302: {
    name: '神山高校 空教室',
    category: '校园',
    timeOfDay: '黄昏',
    indoor: '室内',
    tags: ['神山高校', '教室', '空教室', '校园', '黄昏', '室内']
  },
  bg_a000306: {
    name: '神山高校 三年教室（暗灯）',
    category: '校园',
    timeOfDay: '夜晚',
    indoor: '室内',
    tags: ['神山高校', '教室', '夜晚', '关灯', '文化祭准备']
  },
  bg_a000401: {
    name: '宫益坂女子学园 教室',
    category: '校园',
    timeOfDay: '白天',
    indoor: '室内',
    tags: ['宫益坂女子学园', '教室', '校园', '白天', '室内']
  },
  bg_a000402: {
    name: '宫益坂女子学园 空教室',
    category: '校园',
    timeOfDay: '黄昏',
    indoor: '室内',
    tags: ['宫益坂女子学园', '教室', '空教室', '校园', '黄昏', '室内']
  },
  bg_a000403: {
    name: '宫益坂女子学园 教室（夜晚）',
    category: '校园',
    timeOfDay: '夜晚',
    indoor: '室内',
    tags: ['宫益坂女子学园', '教室', '校园', '夜晚', '室内']
  },
  bg_a000901: {
    name: '宫益坂女子学园 操场',
    category: '校园',
    timeOfDay: '白天',
    indoor: '室外',
    tags: ['宫益坂女子学园', '操场', '校园', '白天', '室外']
  },
  bg_a002801: {
    name: '天台',
    aliases: ['病院 屋上'],
    category: '校园',
    timeOfDay: '白天',
    indoor: '室外',
    tags: ['校园', '室外', '白天', '天台', '病院', '屋上']
  },
  bg_a003101: {
    name: '郊野登山步道',
    category: '自然与旅行',
    timeOfDay: '白天',
    indoor: '室外',
    tags: ['郊外', '山路', '自然', '室外']
  },
  bg_c003101: {
    name: '街头练习空间',
    category: '演出与排练',
    timeOfDay: '通用',
    indoor: '室内',
    tags: ['VBS', '排练室', '街头']
  },
  bg_c003601: {
    name: '街头演出广场',
    category: '涩谷街景',
    timeOfDay: '夜晚',
    indoor: '室外',
    tags: ['VBS', '街头', 'Live', '室外']
  },
  bg_d001401: {
    name: '菲尼克斯奇幻乐园 剧场舞台',
    category: '游乐园与休闲',
    timeOfDay: '白天',
    indoor: '室内',
    tags: ['WxS', '舞台', '剧场', '公演']
  },
  bg_d008001: {
    name: '大型戏剧节会场舞台',
    category: '演出与排练',
    timeOfDay: '通用',
    indoor: '室内',
    tags: ['WxS', '舞台', '剧场', '演出']
  },
  bg_e002901: {
    name: '原宿潮流快闪店街',
    category: '商业与餐饮',
    timeOfDay: '白天',
    indoor: '室外',
    tags: ['25时', '购物', '街道', '时尚']
  },
  bg_g000101: {
    name: '心愿「世界」·纯白空间',
    category: 'SEKAI世界',
    timeOfDay: '通用',
    indoor: '室外',
    tags: ['SEKAI', '虚拟歌手', '心愿世界']
  },
  bg_g000102: {
    name: '心愿「世界」·星光空间',
    category: 'SEKAI世界',
    timeOfDay: '夜晚',
    indoor: '室外',
    tags: ['SEKAI', '虚拟歌手', '心愿世界']
  },
  bg_g000202: {
    name: '舞台「世界」（MMJ）',
    category: 'SEKAI世界',
    timeOfDay: '通用',
    indoor: '室外',
    tags: ['SEKAI', 'MMJ', '舞台']
  },
  bg_g000601: {
    name: '心愿之树「世界」',
    category: 'SEKAI世界',
    timeOfDay: '通用',
    indoor: '室外',
    tags: ['SEKAI', 'WorldLink', '心愿之树']
  },
  bg_link2_leoneed_ed5: {
    name: 'Leo/need 联动纪念舞台',
    category: '演出与排练',
    timeOfDay: '夜晚',
    indoor: '室外',
    tags: ['Leo/need', '舞台', '联动']
  },
  bg_mv_01band_20_ep7: {
    name: 'Leo/need MV 星空演出场景',
    category: '演出与排练',
    timeOfDay: '夜晚',
    indoor: '室外',
    tags: ['Leo/need', 'MV', '演出']
  },
  bg_mv_04wonder_26_ep8: {
    name: 'WxS MV 奇幻演出场景',
    category: '演出与排练',
    timeOfDay: '通用',
    indoor: '室外',
    tags: ['WxS', 'MV', '演出']
  },
  bg00026: {
    name: '早期通用街道背景',
    category: '涩谷街景',
    timeOfDay: '白天',
    indoor: '室外',
    tags: ['街道', '通用']
  }
}

const UNIT_PREFIX_META = {
  bg_a: { unit: '通用', defaultCat: '涩谷街景', defaultPlace: '涩谷·日常公共场景' },
  bg_b: { unit: 'MORE MORE JUMP!', defaultCat: '演出与排练', defaultPlace: 'MMJ 偶像活动空间' },
  bg_c: { unit: 'Vivid BAD SQUAD', defaultCat: '涩谷街景', defaultPlace: 'VBS 街头音乐据点' },
  bg_d: {
    unit: 'Wonderlands×Showtime',
    defaultCat: '游乐园与休闲',
    defaultPlace: '奇幻乐园演剧空间'
  },
  bg_e: {
    unit: '25时，Nightcord de.',
    defaultCat: '住宅与房间',
    defaultPlace: '25时 深夜日常空间'
  },
  bg_f: { unit: 'Leo/need', defaultCat: '校园', defaultPlace: 'Leo/need 校园乐队空间' },
  bg_g: { unit: '虚拟歌手', defaultCat: 'SEKAI世界', defaultPlace: '「世界」交汇空间' },
  bg_h: {
    unit: '25时，Nightcord de.',
    defaultCat: '线上通话',
    defaultPlace: 'Nightcord 线上语音房间'
  },
  bg_i: { unit: '剧场版/特别篇', defaultCat: 'SEKAI世界', defaultPlace: '剧场版特别场景' },
  bg_s: { unit: '剧情插画', defaultCat: '剧情插画', defaultPlace: '剧情特写插画' }
}

function parseArgs(argv) {
  const out = {
    corpora: [],
    episodes: 0,
    region: 'cn',
    out: DEFAULT_OUT,
    cacheDir: DEFAULT_CACHE_DIR,
    catalogCache: DEFAULT_CATALOG_CACHE,
    concurrency: 12,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--corpus') out.corpora.push(next())
    else if (arg === '--episodes') out.episodes = Number(next())
    else if (arg === '--region') out.region = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--cache-dir') out.cacheDir = next()
    else if (arg === '--catalog-cache') out.catalogCache = next()
    else if (arg === '--concurrency') out.concurrency = Number(next())
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJson(url, { retries = 4 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'msst-background-names/2' } })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      return await res.json()
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(400 * (attempt + 1))
    }
  }
  throw lastError
}

function cleanText(raw) {
  return String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\u3000+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasHangul(text) {
  return /[\uac00-\ud7af]/.test(text)
}

function hasKana(text) {
  return /[\u3040-\u30ff]/.test(text)
}

function normalizePlaceName(raw) {
  let text = cleanText(raw)
  if (!text) return ''
  // 若包含日文常见词，先做可控词条替换，减少日混杂
  if (hasKana(text) || /[３２１ＡＢＣ]組|学園/.test(text)) {
    for (const [jp, cn] of JP_TO_CN_PLACE) {
      if (jp === 'の') continue
      text = text.split(jp).join(cn)
    }
    text = text.replace(/([\u4e00-\u9fff])の([\u4e00-\u9fff])/g, '$1的$2')
  }
  return text.replace(/\s+/g, ' ').trim()
}

export function isNonLocationTelop(text) {
  const cleaned = cleanText(text)
  if (!cleaned || cleaned.length > 26 || PLACEHOLDER.test(cleaned)) return true
  if (hasHangul(cleaned)) return true
  return NON_LOCATION_TELOP.test(cleaned)
}

/** 读取 scenario JSON 里某个背景被设置期间出现的 PlaceInfo/Telop 文本（仅返回地点对，兼容旧单测）。 */
export function locationsOfScenario(scenario) {
  const pairs = []
  let current = String(scenario.FirstBackground || '')
  for (const snippet of scenario.Snippets || []) {
    if (Number(snippet.Action) !== 6) continue
    const effect = (scenario.SpecialEffectData || [])[snippet.ReferenceIndex] || {}
    const type = Number(effect.EffectType || 0)
    if (type === 7) {
      current = effect.StringValSub || effect.StringVal || current
      continue
    }
    if (type !== 8 && type !== 18) continue
    const text = cleanText(effect.StringVal || '')
    if (!current || !text) continue
    if (type === 8 && isNonLocationTelop(text)) continue
    if (type === 18 && (text.length > 26 || PLACEHOLDER.test(text))) continue
    pairs.push([current, text])
  }
  return pairs
}

/** 统计每个背景的地点名（PlaceInfo 权重 10 > Telop 权重 1，兼容旧单测）。 */
export function collectNames(scenarios) {
  const counts = new Map()
  for (const scenario of scenarios) {
    let current = String(scenario.FirstBackground || '')
    for (const snippet of scenario.Snippets || []) {
      if (Number(snippet.Action) !== 6) continue
      const effect = (scenario.SpecialEffectData || [])[snippet.ReferenceIndex] || {}
      const type = Number(effect.EffectType || 0)
      if (type === 7) {
        current = effect.StringValSub || effect.StringVal || current
        continue
      }
      if (type !== 8 && type !== 18) continue
      const text = cleanText(effect.StringVal || '')
      if (!current || !text) continue
      if (type === 8 && isNonLocationTelop(text)) continue
      if (type === 18 && (text.length > 26 || PLACEHOLDER.test(text))) continue

      if (!counts.has(current)) counts.set(current, new Map())
      const perBg = counts.get(current)
      const weight = type === 18 ? 10 : 1
      const prev = perBg.get(text) || { score: 0, count: 0 }
      perBg.set(text, { score: prev.score + weight, count: prev.count + 1 })
    }
  }

  const backgrounds = {}
  for (const [id, names] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ranked = [...names.entries()].sort(
      (a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])
    )
    backgrounds[id] = {
      name: ranked[0][0],
      aliases: ranked
        .slice(1, 4)
        .filter(([, meta]) => meta.count >= 2)
        .map(([name]) => name)
    }
  }
  return backgrounds
}

function classifyCategory(id, name, events) {
  const hay = `${id} ${name} ${events.join(' ')}`
  if (id === 'bg_a000000' || /^bg_a0000\d{2}$/.test(id)) return '特效与纯色'
  if (id.startsWith('bg_s')) return '剧情插画'
  if (id.startsWith('bg_h')) return /教室|走廊|学校/.test(name) ? '校园' : '线上通话'
  if (/「世界」|セカイ|sekai/i.test(name) || id.startsWith('bg_g')) return 'SEKAI世界'
  if (
    /高校|学园|学園|学校|教室|走廊|天台|屋上|校门|中庭|图书室|图书馆|保健室|社团|部室|教学楼|体育馆|操场|网球场|泳池/.test(
      name
    )
  ) {
    return '校园'
  }
  if (/房间|的房间|客厅|厨房|卧室|玄关|家|阳台|走廊（家）|公寓|宿舍/.test(name)) return '住宅与房间'
  if (
    /奇幻乐园|游乐园|过山车|摩天轮|旋转木马|水族馆|动物园|海边|海滩|沙滩|公园|温泉|露营|山|神社|祭典|广场/.test(
      name
    )
  ) {
    return '游乐园与休闲'
  }
  if (
    /舞台|排练|练习室|休息室|后台|剧场|剧团|Live|演唱会|会场|音乐厅|录音|乐器|画室|摄影棚|直播/.test(
      name
    )
  ) {
    return '演出与排练'
  }
  if (/医院|病房|诊所|车站|机场|电车|巴士|船|飞机|文化馆|市民馆|福利|教堂|墓地/.test(name)) {
    return '医院与公共'
  }
  if (
    /餐厅|咖啡|商店|购物|百货|便利店|甜品|点心|面包|拉面|商场|快闪|服装|专柜|书店|花店/.test(name)
  ) {
    return '商业与餐饮'
  }
  if (/交叉口|十字路口|宫益坂|涩谷|街道|住宅区|商店街|天桥|巷|大桥|河边|海岸|森林|湖/.test(hay)) {
    return /湖|海|森|山|雪|星/.test(name) ? '自然与旅行' : '涩谷街景'
  }
  return (UNIT_PREFIX_META[id.slice(0, 4)] || UNIT_PREFIX_META.bg_a).defaultCat
}

function classifyIndoor(id, name, category) {
  if (category === '线上通话' || category === '住宅与房间') return '室内'
  if (
    /室内|教室|走廊|保健室|图书|房间|客厅|厨房|病房|医院|餐厅|咖啡|商店|百货|购物|排练室|练习室|休息室|后台|画室|录音|电车|车厢|直播|大厅|馆内|事务所|屋内|玄关|礼堂|体育馆|剧场内|帐篷|地下/.test(
      name
    )
  ) {
    return '室内'
  }
  if (
    /天台|屋上|中庭|校门|教学楼后|操场|网球场|十字路口|宫益坂|街道|住宅区|广场|公园|乐园|舞台|海边|沙滩|海岸|山|湖|森林|神社|车站前|桥|路上|室外|屋外|庭院|街头|外景/.test(
      name
    )
  ) {
    return '室外'
  }
  if (id.startsWith('bg_h')) return '室内'
  if (id.startsWith('bg_e') && /000[1-4679]|001[0-8]/.test(id)) return '室内'
  return category === '校园' ? '室内' : '室外'
}

function inferTimeOfDay(id, name, stat, siblingVariants) {
  if (/深夜|25点|凌晨/.test(name)) return '深夜'
  if (/黄昏|傍晚|夕阳/.test(name)) return '黄昏'
  if (/夜晚|夜空|晚上|夜景|暗灯/.test(name)) return '夜晚'
  if (/白天|清晨|上午|中午|午休/.test(name)) return '白天'
  if (id.startsWith('bg_h') || id.startsWith('bg_s')) return '通用'

  if (stat) {
    const { day, evening, night, midnight } = stat.timeHits
    const entries = [
      ['深夜', midnight],
      ['夜晚', night],
      ['黄昏', evening],
      ['白天', day]
    ].sort((a, b) => b[1] - a[1])
    if (entries[0][1] >= 2 && entries[0][1] > entries[1][1]) {
      return entries[0][0]
    }
  }

  // 若同一基底地点有多个时段/光照变体（01/02/03），依据常见顺序推断
  if (siblingVariants.length >= 2) {
    const idx = siblingVariants.indexOf(id)
    const suffix = Number(id.slice(-2))
    if (id.startsWith('bg_e0001') || id.startsWith('bg_e0002')) {
      if (suffix === 1) return '白天'
      if (suffix === 2 || suffix === 3) return '深夜'
      if (suffix >= 8) return '夜晚'
    }
    if (idx === 0) return '白天'
    if (idx === 1) return siblingVariants.length === 2 ? '夜晚' : '黄昏'
    if (idx === 2) return '夜晚'
  }

  if (id.startsWith('bg_e') || id.startsWith('bg_h')) return '夜晚'
  return '通用'
}

function makeTags({ id, name, aliases, category, timeOfDay, indoor, unit, events }) {
  const tags = new Set([category, indoor])
  if (timeOfDay !== '通用') tags.add(timeOfDay)
  if (unit && unit !== '通用') tags.add(unit)
  for (const token of name.split(/[\s·（）()「」/]+/)) {
    if (token && token.length >= 2 && token.length <= 12) tags.add(token)
  }
  for (const a of aliases.slice(0, 2)) {
    for (const token of a.split(/[\s·（）()「」/]+/)) {
      if (token && token.length >= 2 && token.length <= 12) tags.add(token)
    }
  }
  if (id.startsWith('bg_s') && events.length > 0) {
    tags.add(events[0].slice(0, 14))
  }
  return [...tags].slice(0, 8)
}

function readJsonDir(dir, sourceTag) {
  if (!dir || !fs.existsSync(dir)) return []
  const out = []
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      out.push({ file, sourceTag, data })
    } catch {
      // ignore corrupt json
    }
  }
  return out
}

async function listRemoteBackgroundIds() {
  for (const origin of [STORAGE_ORIGIN, STORAGE_BACKUP_ORIGIN]) {
    try {
      const listing = await fetchJson(`${origin}/sekai-jp-assets/scenario/background/`)
      const dirs = Array.isArray(listing.directories) ? listing.directories : []
      return [...new Set(dirs.filter((name) => /^bg/i.test(name) && name !== 'background'))].sort()
    } catch {
      // try backup origin
    }
  }
  return []
}

function buildScenarioCorpus({ corpora, cacheDir }) {
  const entries = []
  if (corpora.length > 0) {
    for (const dir of corpora) entries.push(...readJsonDir(dir, 'cn-corpus'))
    return entries
  }
  if (DEFAULT_CN_CORPUS && fs.existsSync(DEFAULT_CN_CORPUS)) {
    entries.push(...readJsonDir(DEFAULT_CN_CORPUS, 'cn-corpus'))
  }
  const cacheSubdirs = [
    ['cn_events', 'cn-event'],
    ['cn_stories', 'cn-story'],
    ['cn_actionsets', 'cn-actionset'],
    ['jp_new_stories', 'jp-new']
  ]
  for (const [sub, tag] of cacheSubdirs) {
    entries.push(...readJsonDir(path.join(cacheDir, sub), tag))
  }
  return entries
}

const CHAR_SHORT_BY_PREFIX = {
  '01': '一歌',
  '02': '咲希',
  '03': '穗波',
  '04': '志步',
  '05': '实乃理',
  '06': '遥',
  '07': '爱莉',
  '08': '雫',
  '09': '心羽',
  10: '杏',
  11: '彰人',
  12: '冬弥',
  13: '司',
  14: '笑梦',
  15: '宁宁',
  16: '类',
  17: '奏',
  18: '真冬',
  19: '绘名',
  20: '瑞希',
  21: '初音未来',
  22: '镜音铃',
  23: '镜音连',
  24: '巡音流歌',
  25: 'MEIKO',
  26: 'KAITO'
}

function charNameFromCostume(costume) {
  const m = /^(?:v2_)?(\d{2})/.exec(String(costume || ''))
  return m ? CHAR_SHORT_BY_PREFIX[m[1]] || '' : ''
}

export async function buildRichBackgroundIndex(options = {}) {
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR
  const catalogCache = options.catalogCache || DEFAULT_CATALOG_CACHE

  // 1. 全量云端背景 ID（优先读本地 catalog.json，缺失则联网拉 bundles）
  let allBgIds = []
  if (fs.existsSync(catalogCache)) {
    try {
      const cat = JSON.parse(fs.readFileSync(catalogCache, 'utf-8'))
      if (Array.isArray(cat.backgrounds) && cat.backgrounds.length > 0) {
        allBgIds = cat.backgrounds.map((b) => b.id).filter(Boolean)
      }
    } catch {
      // fallback to remote
    }
  }
  if (allBgIds.length === 0) {
    allBgIds = await listRemoteBackgroundIds().catch(() => [])
  }

  // 2. CN master DB（活动名、区域名）
  let eventsCn = []
  let eventStoriesCn = []
  let eventsJp = []
  let eventStoriesJp = []
  let areasCn = []
  const readCached = (name) => {
    const p = path.join(cacheDir, name)
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null
  }
  try {
    eventsCn = readCached('events_cn.json') ?? (await fetchJson(`${CN_MASTER_BASE}/events.json`))
    eventStoriesCn =
      readCached('eventStories_cn.json') ?? (await fetchJson(`${CN_MASTER_BASE}/eventStories.json`))
    areasCn = readCached('areas_cn.json') ?? (await fetchJson(`${CN_MASTER_BASE}/areas.json`))
    eventsJp =
      readCached('events_jp.json') ??
      (await fetchJson(`${JP_MASTER_BASE}/events.json`).catch(() => []))
    eventStoriesJp =
      readCached('eventStories_jp.json') ??
      (await fetchJson(`${JP_MASTER_BASE}/eventStories.json`).catch(() => []))
  } catch {
    // 离线容错
  }

  const eventNameByAsset = new Map()
  const cnNameById = new Map(eventsCn.map((e) => [e.id, cleanText(e.name)]))
  for (const es of eventStoriesCn) {
    const name = cnNameById.get(es.eventId)
    if (name) eventNameByAsset.set(es.assetbundleName, name)
  }
  const jpNameById = new Map(eventsJp.map((e) => [e.id, cleanText(e.name)]))
  for (const es of eventStoriesJp) {
    if (!eventNameByAsset.has(es.assetbundleName)) {
      const name = jpNameById.get(es.eventId)
      if (name) eventNameByAsset.set(es.assetbundleName, name)
    }
  }

  // 3. 扫描全量剧情语料，统计 PlaceInfo(18) / Telop(8) / 时段线索 / 角色与活动共现
  const scenarios = buildScenarioCorpus({ corpora: options.corpora || [], cacheDir })
  const stats = new Map()
  const ensureStat = (id) => {
    if (!stats.has(id)) {
      stats.set(id, {
        cnPlace: new Map(),
        jpPlace: new Map(),
        events: new Set(),
        chars: new Map(),
        timeHits: { day: 0, evening: 0, night: 0, midnight: 0 },
        count: 0
      })
    }
    return stats.get(id)
  }

  for (const entry of scenarios) {
    const s = entry.data
    if (!s || typeof s !== 'object') continue
    const isJpOnly = entry.sourceTag === 'jp-new'
    const assetSlug = entry.file.includes('__') ? entry.file.split('__')[0] : ''
    const evName = eventNameByAsset.get(assetSlug) || ''
    const charNames = (s.AppearCharacters || [])
      .map((c) => charNameFromCostume(c.CostumeType))
      .filter(Boolean)

    let current = String(s.FirstBackground || '')
    const recordVisit = (bgId) => {
      if (!bgId) return
      const st = ensureStat(bgId)
      st.count += 1
      if (evName) st.events.add(evName)
      for (const ch of charNames) st.chars.set(ch, (st.chars.get(ch) || 0) + 1)
    }
    recordVisit(current)

    for (const snippet of s.Snippets || []) {
      const action = Number(snippet.Action)
      if (action === 6) {
        const ef = (s.SpecialEffectData || [])[snippet.ReferenceIndex] || {}
        const type = Number(ef.EffectType || 0)
        if (type === 7) {
          current = ef.StringValSub || ef.StringVal || current
          recordVisit(current)
          continue
        }
        if ((type === 8 || type === 18) && current) {
          const rawTxt = cleanText(ef.StringVal || '')
          if (!rawTxt || PLACEHOLDER.test(rawTxt) || hasHangul(rawTxt)) continue
          const st = ensureStat(current)
          if (/深夜|25点|凌晨|半夜/.test(rawTxt)) st.timeHits.midnight += 2
          else if (/傍晚|黄昏|夕阳|夕方/.test(rawTxt)) st.timeHits.evening += 2
          else if (/夜晚|夜|晚上|今晚/.test(rawTxt)) st.timeHits.night += 2
          else if (/早上|清晨|上午|中午|午休|白天|朝|昼/.test(rawTxt)) st.timeHits.day += 2

          if (isNonLocationTelop(rawTxt)) continue
          if (rawTxt.length > 26 || /^bg_a0000\d{2}$/.test(current)) continue
          const normalized = normalizePlaceName(rawTxt)
          if (!normalized || isNonLocationTelop(normalized)) continue
          const weight = type === 18 ? 10 : 1
          const targetMap = isJpOnly || hasKana(normalized) ? st.jpPlace : st.cnPlace
          targetMap.set(normalized, (targetMap.get(normalized) || 0) + weight)
        }
      } else if (action === 1 && current) {
        const td = (s.TalkData || [])[snippet.ReferenceIndex]
        const body = String(td?.Body || '')
        if (!body) continue
        const st = ensureStat(current)
        if (/深夜|25点|凌晨|半夜|熬夜/.test(body)) st.timeHits.midnight += 1
        else if (/夕阳|黄昏|傍晚|晚霞/.test(body)) st.timeHits.evening += 1
        else if (/晚安|月亮|夜空|今晚|这么晚/.test(body)) st.timeHits.night += 1
        else if (/早上好|早安|午休|中午|太阳/.test(body)) st.timeHits.day += 1
      }
    }
  }

  const allIds = [...new Set([...allBgIds, ...stats.keys()])]
    .filter((id) => /^bg/i.test(id) && id !== 'background')
    .sort()

  // 4. 构建基底组（去掉末尾两位变体编号）用于同源继承与多时段标注
  const baseGroups = new Map()
  const baseRankedNames = new Map()
  for (const id of allIds) {
    if (/^bg_a0000\d{2}$/.test(id) || id.startsWith('bg_s') || id.startsWith('bg_h')) continue
    const base = id.replace(/\d{2}$/, '')
    if (!baseGroups.has(base)) baseGroups.set(base, [])
    baseGroups.get(base).push(id)
  }

  const rankPlaceMap = (st) => {
    if (!st) return []
    const merged = new Map()
    for (const [k, v] of st.cnPlace) merged.set(k, (merged.get(k) || 0) + v * 5)
    for (const [k, v] of st.jpPlace) merged.set(k, (merged.get(k) || 0) + v)
    return [...merged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }

  for (const [base, ids] of baseGroups) {
    const agg = new Map()
    for (const id of ids) {
      for (const [name, score] of rankPlaceMap(stats.get(id))) {
        agg.set(name, (agg.get(name) || 0) + score)
      }
    }
    baseRankedNames.set(
      base,
      [...agg.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    )
  }

  // 5. 组装全量背景语义词典
  const areaNamesCn = areasCn.map((a) => cleanText(a.name)).filter(Boolean)
  const backgrounds = {}

  for (const id of allIds) {
    const st = stats.get(id)
    const base = id.replace(/\d{2}$/, '')
    const siblings = baseGroups.get(base) || [id]
    const prefixMeta = UNIT_PREFIX_META[id.slice(0, 4)] || UNIT_PREFIX_META.bg_a
    const events = st ? [...st.events] : []
    const topChars = st
      ? [...st.chars.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([c]) => c)
      : []

    const curated = CURATED_BG_NAMES[id]
    let name = ''
    let aliases = []

    if (curated) {
      name = curated.name
    } else {
      const directRanked = rankPlaceMap(st)
      const baseRanked = baseRankedNames.get(base) || []
      const chosen = directRanked.length > 0 ? directRanked : baseRanked
      if (chosen.length > 0) {
        name = chosen[0][0]
        aliases = chosen
          .slice(1, 4)
          .filter(([, score]) => score >= 2)
          .map(([alt]) => alt)
      } else if (id.startsWith('bg_s')) {
        const suffix = id.slice(4)
        const cnEvent = events.find((e) => !hasKana(e))
        if (cnEvent && topChars.length > 0) {
          name = `剧情插画·${cnEvent.slice(0, 12)}（${topChars.slice(0, 2).join('、')}）`
        } else if (cnEvent) {
          name = `剧情插画·${cnEvent.slice(0, 14)}`
        } else if (topChars.length > 0) {
          name = `剧情插画·${topChars.slice(0, 2).join('、')}回忆画面`
        } else {
          name = `剧情插画场景 #${suffix.replace(/^0+/, '') || '0'}`
        }
      } else if (id.startsWith('bg_h')) {
        const subGroup = id.slice(4, 8)
        if (topChars.length > 0) {
          name = `Nightcord 语音连线画面（${topChars.slice(0, 2).join('、')}）`
        } else if (events.length > 0) {
          name = `活动专属分屏场景·${events[0].slice(0, 12)}`
        } else {
          name = `Nightcord 线上语音界面 #${subGroup}`
        }
      } else if (/^bg_a0000\d{2}$/.test(id)) {
        name = `纯色/光影氛围幕布 #${id.slice(-2)}`
      } else {
        const cnEvent = events.find((e) => !hasKana(e))
        if (cnEvent) {
          name = `${prefixMeta.defaultPlace}·${cnEvent.slice(0, 10)}`
        } else if (topChars.length > 0) {
          name = `${prefixMeta.defaultPlace}（${topChars.slice(0, 2).join('、')}相关）`
        } else {
          // 参考 areas.json 匹配单元场景兜底
          const unitArea = id.startsWith('bg_f')
            ? areaNamesCn.find((n) => n.includes('教室'))
            : id.startsWith('bg_b')
              ? areaNamesCn.find((n) => n.includes('舞台'))
              : id.startsWith('bg_c')
                ? areaNamesCn.find((n) => n.includes('街头'))
                : id.startsWith('bg_d')
                  ? areaNamesCn.find((n) => n.includes('奇幻'))
                  : id.startsWith('bg_e')
                    ? areaNamesCn.find((n) => n.includes('无人'))
                    : ''
          const serial = id.replace(/^bg_[a-z]+0*/i, '') || id
          name = unitArea
            ? `${unitArea}·衍生场景 #${serial}`
            : `${prefixMeta.defaultPlace} #${serial}`
        }
      }
    }

    const category = curated?.category || classifyCategory(id, name, events)
    const indoor = curated?.indoor || classifyIndoor(id, name, category)
    const timeOfDay = curated?.timeOfDay || inferTimeOfDay(id, name, st, siblings)
    const tags =
      curated?.tags ||
      makeTags({
        id,
        name,
        aliases,
        category,
        timeOfDay,
        indoor,
        unit: prefixMeta.unit,
        events
      })

    backgrounds[id] = {
      name,
      aliases,
      category,
      timeOfDay,
      indoor,
      tags
    }
  }

  return {
    backgrounds,
    episodeCount: scenarios.length,
    directNamed: allIds.filter((id) => rankPlaceMap(stats.get(id)).length > 0).length
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(
      'usage: node scripts/assets/build-background-names.mjs [--corpus <dir>] [--cache-dir <dir>] [--out <file>]'
    )
    return
  }
  const { backgrounds, episodeCount, directNamed } = await buildRichBackgroundIndex(args)
  const payload = {
    format: 'msst.background-names/1',
    generatedAt: new Date().toISOString(),
    source: `cn-official-corpus:${episodeCount}scenarios`,
    backgrounds
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  const total = Object.keys(backgrounds).length
  console.log(
    `wrote ${total} backgrounds (${directNamed} directly named from PlaceInfo/Telop, ${episodeCount} scenarios) to ${args.out}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
