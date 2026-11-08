/** Project SEKAI 26 位角色在模型 id / MasterCharacter 里的中文名。 */
export interface CharacterName {
  characterId: number
  name: string
  shortName: string
  /** 模型 id 里常见的罗马字片段，用于 --characters mizuki 这类筛选 */
  keys: string[]
}

export const CHARACTERS: CharacterName[] = [
  { characterId: 1, name: '星乃一歌', shortName: '一歌', keys: ['ichika'] },
  { characterId: 2, name: '天马咲希', shortName: '咲希', keys: ['saki'] },
  { characterId: 3, name: '望月穗波', shortName: '穗波', keys: ['honami'] },
  { characterId: 4, name: '日野森志步', shortName: '志步', keys: ['shiho'] },
  { characterId: 5, name: '花里实乃理', shortName: '实乃理', keys: ['minori'] },
  { characterId: 6, name: '桐谷遥', shortName: '遥', keys: ['haruka'] },
  { characterId: 7, name: '桃井爱莉', shortName: '爱莉', keys: ['airi'] },
  { characterId: 8, name: '日野森雫', shortName: '雫', keys: ['shizuku'] },
  { characterId: 9, name: '小豆泽心羽', shortName: '心羽', keys: ['kohane'] },
  { characterId: 10, name: '白石杏', shortName: '杏', keys: ['an'] },
  { characterId: 11, name: '东云彰人', shortName: '彰人', keys: ['akito'] },
  { characterId: 12, name: '青柳冬弥', shortName: '冬弥', keys: ['touya', 'toya'] },
  { characterId: 13, name: '天马司', shortName: '司', keys: ['tsukasa'] },
  { characterId: 14, name: '凤笑梦', shortName: '笑梦', keys: ['emu'] },
  { characterId: 15, name: '草薙宁宁', shortName: '宁宁', keys: ['nene'] },
  { characterId: 16, name: '神代类', shortName: '类', keys: ['rui'] },
  { characterId: 17, name: '宵崎奏', shortName: '奏', keys: ['kanade'] },
  { characterId: 18, name: '朝比奈真冬', shortName: '真冬', keys: ['mafuyu'] },
  { characterId: 19, name: '东云绘名', shortName: '绘名', keys: ['ena'] },
  { characterId: 20, name: '晓山瑞希', shortName: '瑞希', keys: ['mizuki'] },
  { characterId: 21, name: '初音未来', shortName: '初音', keys: ['miku', 'hatsune'] },
  { characterId: 22, name: '镜音铃', shortName: '铃', keys: ['rin'] },
  { characterId: 23, name: '镜音连', shortName: '连', keys: ['len'] },
  { characterId: 24, name: '巡音流歌', shortName: '流歌', keys: ['luka'] },
  { characterId: 25, name: 'MEIKO', shortName: 'MEIKO', keys: ['meiko'] },
  { characterId: 26, name: 'KAITO', shortName: 'KAITO', keys: ['kaito'] }
]

const BY_ID = new Map(CHARACTERS.map((character) => [character.characterId, character]))

export function characterById(id: number | null | undefined): CharacterName | null {
  return typeof id === 'number' ? (BY_ID.get(id) ?? null) : null
}

/**
 * 把 `--characters` 的一个词解析成角色 id：
 * 支持数字、中文全名/简称、罗马字片段；无法对应时返回 null。
 */
export function resolveCharacterToken(token: string): number | null {
  const value = token.trim()
  if (!value) return null
  if (/^\d+$/.test(value)) {
    const id = Number(value)
    return BY_ID.has(id) ? id : null
  }
  const lowered = value.toLowerCase()
  for (const character of CHARACTERS) {
    if (
      character.name === value ||
      character.shortName === value ||
      character.keys.some((key) => key === lowered)
    ) {
      return character.characterId
    }
  }
  // 允许用完整模型 id 里的片段（例如 20mizuki 或 20_mizuki）
  for (const character of CHARACTERS) {
    if (character.keys.some((key) => lowered.includes(key))) {
      return character.characterId
    }
  }
  return null
}

export function isVirtualSinger(id: number): boolean {
  return id >= 21 && id <= 26
}
