#!/usr/bin/env node
/**
 * 生成全量 Live2D 角色服装与场景音效简体中文语义索引：
 * 1. src/host/assets/model-metadata.json
 *    - 覆盖 Moesekai jp/models.json 中全部 26 位主要角色的所有常规服装变体（跳过纯剪影 _black），
 *      以及重要剧情配角/子角色（宁宁号、初音打油、远野新、远野凪、白石谦、朝比奈母/父等）；
 *    - 预先解析 model3Path（避免宿主运行时每次重建目录发 500+ 次 _ripper.json HTTP 请求），
 *      并标注中文服装分类（常服/校服/私服/队服/运动服/泳装/文化祭/演出服/节日服/特殊）。
 * 2. src/host/assets/se-semantics.json
 *    - 覆盖全部云端 scenario SE（~1,639 条），结合 5,400+ 幕官方剧情的台词共现与命名规则，
 *      生成清晰的简体中文分类、说明与标签。
 *
 * 用法：
 *   node scripts/assets/build-model-se-semantics.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_MODEL_OUT = 'src/host/assets/model-metadata.json'
const DEFAULT_SE_OUT = 'src/host/assets/se-semantics.json'
const DEFAULT_CACHE_DIR = 'cache/semantic-build'
const DEFAULT_CATALOG_CACHE = 'cache/moesekai/catalog.json'
const STORAGE_ORIGIN = 'https://storage.pjsk.moe'
const STORAGE_BACKUP_ORIGIN = 'https://storage.exmeaning.com'
const DEFAULT_CN_CORPUS = 'd:/Users/桌面/mzkbot/msst-ai-lab/corpus/raw/cn'

const CHAR_META = {
  1: { name: '星乃一歌', shortName: '一歌', unit: 'Leo/need' },
  2: { name: '天马咲希', shortName: '咲希', unit: 'Leo/need' },
  3: { name: '望月穗波', shortName: '穗波', unit: 'Leo/need' },
  4: { name: '日野森志步', shortName: '志步', unit: 'Leo/need' },
  5: { name: '花里实乃理', shortName: '实乃理', unit: 'MORE MORE JUMP!' },
  6: { name: '桐谷遥', shortName: '遥', unit: 'MORE MORE JUMP!' },
  7: { name: '桃井爱莉', shortName: '爱莉', unit: 'MORE MORE JUMP!' },
  8: { name: '日野森雫', shortName: '雫', unit: 'MORE MORE JUMP!' },
  9: { name: '小豆泽心羽', shortName: '心羽', unit: 'Vivid BAD SQUAD' },
  10: { name: '白石杏', shortName: '杏', unit: 'Vivid BAD SQUAD' },
  11: { name: '东云彰人', shortName: '彰人', unit: 'Vivid BAD SQUAD' },
  12: { name: '青柳冬弥', shortName: '冬弥', unit: 'Vivid BAD SQUAD' },
  13: { name: '天马司', shortName: '司', unit: 'Wonderlands×Showtime' },
  14: { name: '凤笑梦', shortName: '笑梦', unit: 'Wonderlands×Showtime' },
  15: { name: '草薙宁宁', shortName: '宁宁', unit: 'Wonderlands×Showtime' },
  16: { name: '神代类', shortName: '类', unit: 'Wonderlands×Showtime' },
  17: { name: '宵崎奏', shortName: '奏', unit: '25时，Nightcord de.' },
  18: { name: '朝比奈真冬', shortName: '真冬', unit: '25时，Nightcord de.' },
  19: { name: '东云绘名', shortName: '绘名', unit: '25时，Nightcord de.' },
  20: { name: '晓山瑞希', shortName: '瑞希', unit: '25时，Nightcord de.' },
  21: { name: '初音未来', shortName: '初音', unit: '虚拟歌手' },
  22: { name: '镜音铃', shortName: '铃', unit: '虚拟歌手' },
  23: { name: '镜音连', shortName: '连', unit: '虚拟歌手' },
  24: { name: '巡音流歌', shortName: '流歌', unit: '虚拟歌手' },
  25: { name: 'MEIKO', shortName: 'MEIKO', unit: '虚拟歌手' },
  26: { name: 'KAITO', shortName: 'KAITO', unit: '虚拟歌手' }
}

/** 重要 PJSK 剧情配角与特色角色（非 26 主角的 notable sub/mob） */
const NOTABLE_SUB_MAP = {
  sub_nenedayo: {
    name: '宁宁号',
    shortName: '宁宁号',
    unit: 'Wonderlands×Showtime',
    role: '草薙宁宁的演出机器人'
  },
  sub_mikudayo: {
    name: '初音打油',
    shortName: '初音打油',
    unit: '虚拟歌手',
    role: '吉祥物造型初音'
  },
  sub_mikudayoteacher: {
    name: '初音打油老师',
    shortName: '打油老师',
    unit: '虚拟歌手',
    role: '愚人节老师造型'
  },
  sub_mikurobo: {
    name: '初音机器人',
    shortName: '初音机器人',
    unit: '虚拟歌手',
    role: '机械造型初音'
  },
  sub_tsukasadoll: {
    name: '司人偶',
    shortName: '司人偶',
    unit: 'Wonderlands×Showtime',
    role: '天马司人偶'
  },
  sub_wondermascot: {
    name: '奇幻乐园吉祥物',
    shortName: '乐园吉祥物',
    unit: 'Wonderlands×Showtime',
    role: '奇幻乐园吉祥物'
  },
  sub_anfather: {
    name: '白石谦',
    shortName: '谦',
    unit: 'Vivid BAD SQUAD',
    role: '白石杏的父亲 / WEEKEND GARAGE 店长'
  },
  sub_arata: {
    name: '远野新',
    shortName: '新',
    unit: 'Vivid BAD SQUAD',
    role: 'VBS 街头实力派歌者'
  },
  sub_nagi: {
    name: '小豆泽/白石前辈 凪',
    shortName: '凪',
    unit: 'Vivid BAD SQUAD',
    role: '白石谦昔日搭档'
  },
  sub_partner: {
    name: '大河（相棒）',
    shortName: '大河',
    unit: 'Vivid BAD SQUAD',
    role: '传说活动搭档'
  },
  sub_mizukisister: {
    name: '晓山由衣（瑞希姐姐）',
    shortName: '瑞希姐姐',
    unit: '25时，Nightcord de.',
    role: '晓山瑞希的姐姐'
  },
  sub_kanadefather: {
    name: '宵崎父',
    shortName: '奏的父亲',
    unit: '25时，Nightcord de.',
    role: '宵崎奏的父亲'
  },
  sub_kanademother: {
    name: '宵崎母',
    shortName: '奏的母亲',
    unit: '25时，Nightcord de.',
    role: '宵崎奏的母亲'
  },
  sub_mafuyufather: {
    name: '朝比奈父',
    shortName: '真冬父亲',
    unit: '25时，Nightcord de.',
    role: '朝比奈真冬的父亲'
  },
  sub_mafuyumother: {
    name: '朝比奈母',
    shortName: '真冬母亲',
    unit: '25时，Nightcord de.',
    role: '朝比奈真冬的母亲'
  },
  sub_shinonomefather: {
    name: '东云父',
    shortName: '东云父',
    unit: '25时，Nightcord de.',
    role: '彰人与绘名的父亲'
  },
  sub_touyafather: {
    name: '青柳春道',
    shortName: '冬弥父亲',
    unit: 'Vivid BAD SQUAD',
    role: '青柳冬弥的父亲'
  },
  sub_otorifather: {
    name: '凤父',
    shortName: '凤父',
    unit: 'Wonderlands×Showtime',
    role: '凤笑梦的父亲'
  },
  sub_otorisister: {
    name: '凤日向',
    shortName: '笑梦姐姐',
    unit: 'Wonderlands×Showtime',
    role: '凤笑梦的姐姐'
  },
  sub_iori: { name: '伊织', shortName: '伊织', unit: 'Leo/need', role: '独立乐队主唱' },
  sub_saku: { name: '三田佐久', shortName: '佐久', unit: 'Leo/need', role: '音乐人前辈' },
  sub_futaba: { name: '双叶', shortName: '双叶', unit: 'Leo/need', role: '乐队同伴' },
  sub_arisa: { name: '爱里沙', shortName: '爱里沙', unit: 'MORE MORE JUMP!', role: 'QT 偶像成员' },
  sub_mai: { name: '舞', shortName: '舞', unit: 'MORE MORE JUMP!', role: 'ASRUN 时期前辈' },
  sub_asahi: { name: '朝日', shortName: '朝日', unit: 'Wonderlands×Showtime', role: '剧团演员' },
  sub_saito: { name: '齐藤', shortName: '齐藤', unit: 'MORE MORE JUMP!', role: '偶像事务所经纪人' },
  sub_sakaki: { name: '榊', shortName: '榊', unit: 'Wonderlands×Showtime', role: '剧团相关人物' },
  sub_yuina: { name: '唯奈', shortName: '唯奈', unit: 'Vivid BAD SQUAD', role: '剧情配角' },
  sub_riho: { name: '里穗', shortName: '里穗', unit: 'MORE MORE JUMP!', role: '剧情配角' }
}

function classifyOutfit(modelId, characterId) {
  const clean = modelId.replace(/^v2_/, '')
  const isV2 = modelId.startsWith('v2_')
  const verTag = isV2 ? '新立绘' : ''
  const isVs = typeof characterId === 'number' && characterId >= 21 && characterId <= 26

  if (/black\d*$/i.test(clean)) return { category: '特殊', label: '暗色剪影', isDefault: false }
  if (clean.includes('child')) return { category: '特殊', label: '幼年时期', isDefault: false }
  if (/^clb\d+_/i.test(clean)) return { category: '联动', label: '联动服装', isDefault: false }
  if (clean.includes('april')) return { category: '活动', label: '愚人节限定服', isDefault: false }

  const suffix = clean.replace(/^\d{2}[a-z]+_/, '')
  if (suffix === 'normal') {
    return {
      category: '常服',
      label: isV2 ? '日常常服(新版)' : '日常常服',
      isDefault: !isV2
    }
  }
  if (suffix.startsWith('casual'))
    return { category: '私服', label: `私服${verTag ? `(${verTag})` : ''}`, isDefault: false }
  if (suffix.startsWith('school'))
    return { category: '校服', label: `校服${verTag ? `(${verTag})` : ''}`, isDefault: false }
  if (suffix.startsWith('jc')) return { category: '校服', label: '初中校服', isDefault: false }
  if (suffix.startsWith('unit') || suffix.startsWith('longunit'))
    return { category: '队服', label: `团体队服${verTag ? `(${verTag})` : ''}`, isDefault: false }
  if (suffix.includes('darkunit'))
    return { category: '队服', label: `暗色队服${verTag ? `(${verTag})` : ''}`, isDefault: false }
  if (suffix.startsWith('sports'))
    return { category: '运动服', label: '运动服/体操服', isDefault: false }
  if (suffix.startsWith('swim')) return { category: '泳装', label: '泳装', isDefault: false }
  if (suffix.startsWith('pajamas')) return { category: '私服', label: '睡衣', isDefault: false }
  if (suffix.startsWith('parttime'))
    return { category: '打工服', label: '打工服', isDefault: false }
  if (suffix.startsWith('lesson')) return { category: '运动服', label: '练习服', isDefault: false }
  if (suffix.startsWith('culture'))
    return { category: '活动', label: '文化祭服装', isDefault: false }
  if (suffix.startsWith('yukata') || suffix.startsWith('kimono') || suffix.startsWith('haregi')) {
    return { category: '和服', label: '和服/浴衣', isDefault: false }
  }
  if (suffix.startsWith('christmas'))
    return { category: '活动', label: '圣诞服装', isDefault: false }
  if (suffix.startsWith('wedding') || suffix.startsWith('tuxedo'))
    return { category: '礼服', label: '礼服', isDefault: false }
  if (suffix.startsWith('archery')) return { category: '活动', label: '弓道服', isDefault: false }
  if (suffix.startsWith('priestess')) return { category: '活动', label: '巫女服', isDefault: false }
  if (suffix.startsWith('police')) return { category: '活动', label: '警服', isDefault: false }
  if (suffix.startsWith('tenniswear'))
    return { category: '运动服', label: '网球服', isDefault: false }
  if (suffix.includes('fancostume'))
    return { category: '演出服', label: `粉丝应援演出服(${suffix})`, isDefault: false }
  if (suffix.startsWith('cloth'))
    return { category: '演出服', label: `活动演出服(${suffix})`, isDefault: false }

  if (isVs) {
    if (suffix.startsWith('band'))
      return {
        category: '队服',
        label: `教室世界(L/n风)${verTag ? `(${verTag})` : ''}`,
        isDefault: false
      }
    if (suffix.startsWith('idol'))
      return {
        category: '队服',
        label: `舞台世界(MMJ风)${verTag ? `(${verTag})` : ''}`,
        isDefault: false
      }
    if (suffix.startsWith('street'))
      return {
        category: '队服',
        label: `街头世界(VBS风)${verTag ? `(${verTag})` : ''}`,
        isDefault: false
      }
    if (suffix.startsWith('wonder'))
      return {
        category: '队服',
        label: `乐园世界(WxS风)${verTag ? `(${verTag})` : ''}`,
        isDefault: false
      }
    if (suffix.startsWith('night'))
      return {
        category: '队服',
        label: `无人世界(25时风)${verTag ? `(${verTag})` : ''}`,
        isDefault: false
      }
  }

  return { category: '活动', label: `特别服装(${suffix})`, isDefault: false }
}

async function mapPool(items, limit, worker) {
  let i = 0
  const out = new Array(items.length)
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await worker(items[idx], idx)
      }
    })
  )
  return out
}

async function fetchJsonWithBackup(relPath) {
  for (const origin of [STORAGE_ORIGIN, STORAGE_BACKUP_ORIGIN]) {
    try {
      const r = await fetch(`${origin}${relPath}`)
      if (r.ok) return await r.json()
    } catch {
      // try backup
    }
  }
  throw new Error(`failed to fetch ${relPath}`)
}

async function buildModelsMetadata(existingFile) {
  let existingModels = {}
  if (fs.existsSync(existingFile)) {
    try {
      existingModels = JSON.parse(fs.readFileSync(existingFile, 'utf-8')).models || {}
    } catch {
      existingModels = {}
    }
  }

  const [modelListing, motionListing] = await Promise.all([
    fetchJsonWithBackup('/listings/jp/canonical/live2d-model'),
    fetchJsonWithBackup('/listings/jp/canonical/live2d-motions').catch(() => ({ assets: [] }))
  ])
  const motionSetIds = new Set(
    (motionListing.assets || [])
      .map((a) => /^live2d\/motion\/([^/]+)\//.exec(a.name || '')?.[1])
      .filter(Boolean)
  )
  const seenIds = new Set()
  const indexModels = []
  for (const asset of modelListing.assets || []) {
    const id = /^live2d\/model\/([^/]+)\//.exec(asset.name || '')?.[1]
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    const charMatch = /^(?:v2_)?(?:clb\d+_)?(0[1-9]|1\d|2[0-6])[a-z]+/.exec(id)
    const characterId = charMatch ? Number(charMatch[1]) : null
    const kind = characterId !== null ? 'character' : /^(?:v2_)?sub_/.test(id) ? 'sub' : 'mob'
    const baseStem = id.replace(/^v2_/, '').replace(/_\d+$/, '')
    const hasMotion =
      motionSetIds.has(`${id}_motion_base`) ||
      motionSetIds.has(`${baseStem}_motion_base`) ||
      Boolean(charMatch)
    indexModels.push({
      id,
      bundle: `live2d/model/${id}`,
      kind,
      characterId,
      motion: hasMotion ? '1' : null
    })
  }

  const candidates = indexModels.filter((m) => {
    if (/black\d*$/i.test(m.id)) return false
    if (m.kind === 'character' && typeof m.characterId === 'number') return true
    if (NOTABLE_SUB_MAP[m.id]) return true
    if (m.kind === 'sub' && m.motion) return true
    return false
  })

  console.log(`Resolving model3 paths for ${candidates.length} cloud models...`)
  const resolved = await mapPool(candidates, 24, async (entry) => {
    let model3Path = existingModels[entry.id]?.model3Path || ''
    if (!model3Path) {
      try {
        const dirListing = await fetchJsonWithBackup(`/sekai-jp-assets/${entry.bundle}/`)
        const m3 = (dirListing.files || []).find(
          (f) => typeof f.name === 'string' && f.name.endsWith('.model3.json')
        )
        if (m3) model3Path = m3.name
      } catch {
        // fallback to deterministic id.model3.json if storage view lacks explicit model3
      }
    }
    if (!model3Path) model3Path = `${entry.id}.model3.json`

    const charMeta = typeof entry.characterId === 'number' ? CHAR_META[entry.characterId] : null
    const subMeta = NOTABLE_SUB_MAP[entry.id]
    const outfit = classifyOutfit(entry.id, entry.characterId)

    let name = charMeta?.name || subMeta?.name || entry.id
    let shortName = charMeta?.shortName || subMeta?.shortName || entry.id
    let unit = charMeta?.unit || subMeta?.unit || '联动/特别'

    if (entry.id.startsWith('v2_sub_sanrio_')) {
      const slug = entry.id.replace('v2_sub_sanrio_', '')
      name = `三丽鸥·${slug}`
      shortName = slug
      unit = '联动'
    } else if (entry.id.startsWith('v2_sub_enst_')) {
      const slug = entry.id.replace('v2_sub_enst_', '').replace(/^\d+/, '')
      name = `偶像梦幻祭·${slug}`
      shortName = slug.split('_')[0]
      unit = '联动'
    } else if (entry.id.startsWith('v2_sub_egg_')) {
      const slug = entry.id.replace('v2_sub_egg_', '').replace(/^\d+_/, '')
      name = `拓麻歌子·${slug}`
      shortName = slug.split('_')[0]
      unit = '联动'
    }

    const variant = path.posix.basename(model3Path, '.model3.json')
    const model3Name = path.posix.basename(model3Path)

    return [
      entry.id,
      {
        id: entry.id,
        characterId: entry.characterId ?? null,
        kind: entry.kind || (entry.characterId ? 'character' : 'sub'),
        name,
        shortName,
        unit,
        outfitCategory: outfit.category,
        outfitLabel: subMeta ? subMeta.role : outfit.label,
        isDefault: Boolean(outfit.isDefault && !subMeta),
        isSubCharacter: !charMeta,
        model3Path,
        cloudPath: `cloud/${entry.id}/${variant}/${model3Name}`
      }
    ]
  })

  const models = {}
  for (const pair of resolved) {
    if (pair) models[pair[0]] = pair[1]
  }
  return models
}

function classifySe(id, contextText) {
  const lower = id.toLowerCase()
  const ctx = contextText || ''

  if (lower.startsWith('se_walk_')) {
    const gender = lower.includes('women') ? '女性' : lower.includes('men') ? '男性' : ''
    return {
      category: '脚步',
      description: `${gender}走动脚步声（${id}）`,
      tags: ['脚步', '走动', ...(gender ? [gender] : [])]
    }
  }
  if (lower.startsWith('se_run_')) {
    const gender = lower.includes('women') ? '女性' : lower.includes('men') ? '男性' : ''
    return {
      category: '脚步',
      description: `${gender}匆忙奔跑脚步声（${id}）`,
      tags: ['脚步', '奔跑', ...(gender ? [gender] : [])]
    }
  }
  if (/se00043|se00044|se00001|door/.test(lower)) {
    return {
      category: '开关门',
      description: `开关门 / 推门进出声（${id}）`,
      tags: ['门', '开门', '关门']
    }
  }
  if (/se00004|se00183|phone|ring/.test(lower)) {
    return {
      category: '手机通知',
      description: `手机消息提示音 / 屏幕操作音（${id}）`,
      tags: ['手机', '消息', '通知']
    }
  }
  if (/se00084|se00098|call/.test(lower)) {
    return {
      category: '语音通话',
      description: `Nightcord / 语音通话连线提示音（${id}）`,
      tags: ['通话', 'Nightcord', '上线']
    }
  }
  if (/se00122|paper|book|page/.test(lower)) {
    return {
      category: '纸张乐谱',
      description: `翻动纸张 / 乐谱 / 笔记本声（${id}）`,
      tags: ['纸张', '乐谱', '笔记本']
    }
  }
  if (/se00007|se00320|key|mouse|pc/.test(lower)) {
    return {
      category: '键盘鼠标',
      description: `电脑键盘敲击 / 鼠标 / 编曲操作声（${id}）`,
      tags: ['电脑', '键盘', '编曲']
    }
  }
  if (/se00249|bell|chime/.test(lower)) {
    return {
      category: '校园铃声',
      description: `校园上下课铃声 / 钟声（${id}）`,
      tags: ['校园', '铃声', '钟声']
    }
  }
  if (/se00075|camera|shutter/.test(lower)) {
    return { category: '拍摄快门', description: `相机快门拍照声（${id}）`, tags: ['相机', '拍照'] }
  }
  if (/se00053|se00092|sekai|transition/.test(lower)) {
    return {
      category: '世界观转场',
      description: `回忆白光 / SEKAI 转场氛围音效（${id}）`,
      tags: ['回忆', '转场', 'SEKAI']
    }
  }
  if (/se00034|crowd/.test(lower)) {
    return {
      category: '人群环境',
      description: `人群喧闹 / 会场环境背景音（${id}）`,
      tags: ['人群', '环境', '会场']
    }
  }
  if (/se00028/.test(lower)) {
    return {
      category: '心跳惊觉',
      description: `突然惊觉 / 心头一震音效（${id}）`,
      tags: ['惊讶', '震动', '转折']
    }
  }
  if (/se00055/.test(lower)) {
    return {
      category: '日常动作',
      description: `起身 / 衣物摩擦 / 拿取背包物声（${id}）`,
      tags: ['衣物', '拿取', '起身']
    }
  }
  if (/se00097/.test(lower)) {
    return {
      category: '气氛凝滞',
      description: `脚步骤停 / 气氛凝固轻响（${id}）`,
      tags: ['停顿', '紧张']
    }
  }

  // 从共现对白推理常见动作音效语义
  if (/开门|推门|关门|进屋|敲门/.test(ctx)) {
    return {
      category: '开关门',
      description: `门窗开关 / 进出房门音效（${id}）`,
      tags: ['门', '进出']
    }
  }
  if (/脚步|跑|走近|冲/.test(ctx)) {
    return {
      category: '脚步',
      description: `角色走动 / 奔跑脚步音效（${id}）`,
      tags: ['脚步', '移动']
    }
  }
  if (/手机|信息|消息|短信|通知|电话/.test(ctx)) {
    return {
      category: '手机通知',
      description: `手机通知 / 电话提示音效（${id}）`,
      tags: ['手机', '通知']
    }
  }
  if (/掌声|拍手|欢呼|观众|舞台|灯光/.test(ctx)) {
    return {
      category: '舞台演出',
      description: `演出掌声 / 欢呼 / 舞台音效（${id}）`,
      tags: ['舞台', '掌声', '演出']
    }
  }
  if (/雨|雷|风|海浪|水|雪/.test(ctx)) {
    return {
      category: '天气自然',
      description: `雨声 / 风声 / 自然环境音效（${id}）`,
      tags: ['自然', '天气']
    }
  }
  if (/乐器|吉他|贝斯|鼓|钢琴|琴弦|试音/.test(ctx)) {
    return {
      category: '乐器音乐',
      description: `乐器拨弦 / 试音 / 音乐创作音效（${id}）`,
      tags: ['乐器', '音乐']
    }
  }
  if (/杯|茶|咖啡|碗|盘|吃|喝/.test(ctx)) {
    return {
      category: '餐饮器皿',
      description: `端放茶杯 / 餐具与餐饮声（${id}）`,
      tags: ['餐饮', '日常物品']
    }
  }
  if (lower.startsWith('se_event_')) {
    const slug = id.replace(/^se_event_/i, '').replace(/_\d+.*$/, '')
    return {
      category: '活动专属',
      description: `活动剧情专属音效：${slug || id}`,
      tags: ['活动', slug].filter(Boolean)
    }
  }
  return {
    category: '日常环境',
    description: `剧情环境与动作音效（${id}）`,
    tags: ['剧情', '日常']
  }
}

async function buildSeSemantics({ cacheDir, catalogCache, existingFile }) {
  let seEntries = []
  if (fs.existsSync(catalogCache)) {
    try {
      const cat = JSON.parse(fs.readFileSync(catalogCache, 'utf-8'))
      if (Array.isArray(cat.se)) seEntries = cat.se
    } catch {
      // ignore
    }
  }
  try {
    const seDirs = await fetchJsonWithBackup('/sekai-jp-assets/sound/scenario/se/')
    for (const dir of seDirs.directories || []) {
      const listing = await fetchJsonWithBackup(`/sekai-jp-assets/sound/scenario/se/${dir}/`).catch(
        () => ({ files: [] })
      )
      for (const f of listing.files || []) {
        if (typeof f.name === 'string') {
          const id = f.name.replace(/\.[^.]+$/, '')
          seEntries.push({ id })
        }
      }
    }
  } catch {
    // offline fallback
  }
  let existingCues = {}
  if (existingFile && fs.existsSync(existingFile)) {
    try {
      existingCues = JSON.parse(fs.readFileSync(existingFile, 'utf-8')).cues || {}
    } catch {
      existingCues = {}
    }
  }

  // 从语料收集 SE 周边台词上下文
  const seContext = new Map()
  const dirs = [
    DEFAULT_CN_CORPUS,
    path.join(cacheDir, 'cn_events'),
    path.join(cacheDir, 'cn_stories')
  ]
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      let s
      try {
        s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      } catch {
        continue
      }
      const snippets = s.Snippets || []
      const talks = s.TalkData || []
      const sounds = s.SoundData || []
      for (let i = 0; i < snippets.length; i++) {
        const sn = snippets[i]
        if (sn.Action !== 7) continue
        const sd = sounds[sn.ReferenceIndex]
        if (!sd?.Se) continue
        const near = []
        for (let j = Math.max(0, i - 1); j <= Math.min(snippets.length - 1, i + 2); j++) {
          if (snippets[j].Action === 1) {
            const body = talks[snippets[j].ReferenceIndex]?.Body
            if (body) near.push(String(body).replace(/\s+/g, ' ').slice(0, 40))
          }
        }
        if (near.length > 0) {
          const prev = seContext.get(sd.Se) || []
          if (prev.length < 4) {
            prev.push(...near)
            seContext.set(sd.Se, prev)
          }
        }
      }
    }
  }

  const allSeIds = new Set([...Object.keys(existingCues), ...seEntries.map((e) => e.id)])
  for (const key of seContext.keys()) allSeIds.add(key)

  const cues = {}
  for (const id of [...allSeIds].sort()) {
    const baseId = id.replace(/(?:_b)?_\d+$/, '')
    const ctx = (seContext.get(id) || seContext.get(baseId) || []).join(' ')
    const info = existingCues[id]
      ? {
          category: existingCues[id].category,
          description: existingCues[id].description,
          tags: existingCues[id].tags
        }
      : classifySe(id, ctx)
    cues[id] = {
      id,
      file: `${id}.mp3`,
      category: info.category,
      description: info.description,
      tags: info.tags
    }
  }
  return cues
}

async function main() {
  const models = await buildModelsMetadata(DEFAULT_MODEL_OUT)
  fs.mkdirSync(path.dirname(DEFAULT_MODEL_OUT), { recursive: true })
  fs.writeFileSync(
    DEFAULT_MODEL_OUT,
    `${JSON.stringify(
      {
        format: 'msst.model-metadata/1',
        generatedAt: new Date().toISOString(),
        models
      },
      null,
      2
    )}\n`,
    'utf-8'
  )

  const cues = await buildSeSemantics({
    cacheDir: DEFAULT_CACHE_DIR,
    catalogCache: DEFAULT_CATALOG_CACHE,
    existingFile: DEFAULT_SE_OUT
  })
  fs.writeFileSync(
    DEFAULT_SE_OUT,
    `${JSON.stringify(
      {
        format: 'msst.se-semantics/1',
        generatedAt: new Date().toISOString(),
        cues
      },
      null,
      2
    )}\n`,
    'utf-8'
  )
  console.log(
    `wrote ${Object.keys(models).length} models to ${DEFAULT_MODEL_OUT} and ${Object.keys(cues).length} SE cues to ${DEFAULT_SE_OUT}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
