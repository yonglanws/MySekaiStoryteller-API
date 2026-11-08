#!/usr/bin/env node
/**
 * PJSK scenario JSON → MySekaiStoryteller `.sekai-story.json`
 *
 * 用途：把官方剧情脚本（SekaiStoryRipper / exmeaning 资源站的 scenario JSON）
 * 按场景指令逐条翻译成宿主的时间线片段。角色、背景、BGM、SE 均需事先落到
 * resources/ 下；本脚本只做转换，不下载资源。
 *
 * 用法：
 *   node scripts/stories/pjsk-scenario.mjs \
 *     --scenario /path/event_145_08.json \
 *     --config scripts/stories/event_145_08.models.json \
 *     --translation /path/event_145_zh.json --episode 8 \
 *     --out resources/stories/event_145_08.sekai-story.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const out = {
    scenario: '',
    config: '',
    translation: '',
    episode: '',
    out: '',
    dump: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--scenario') out.scenario = next()
    else if (arg === '--config') out.config = next()
    else if (arg === '--translation') out.translation = next()
    else if (arg === '--episode') out.episode = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--dump') out.dump = true
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!out.scenario) throw new Error('--scenario is required')
  if (!out.config) throw new Error('--config is required')
  if (!out.out) throw new Error('--out is required')
  return out
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * PJSK `ScenarioCharacterLayout.Side` → 宿主 Sides + 像素偏移。
 * 官方枚举：0 None / 1 Left / 2 LeftOver / 3 LeftInside / 4 Center /
 * 5 Right / 6 RightOver / 7 RightInside / 8 LeftUnder / 9 LeftInsideUnder /
 * 10 CenterUnder / 11 RightUnder / 12 RightInsideUnder。
 * LeftInside 与 Left、RightInside 与 Right 的 x 相同；Over 位在画外
 * （contentWidth/2 + 819.2），用 Left/Right 加偏移表示。Under 的 y 偏移
 * 当前宿主格式没有字段，按同 x 处理。
 */
export function sideOf(side, offset) {
  const extra = Number(offset) || 0
  switch (Number(side)) {
    case 1:
    case 3:
    case 8:
    case 9:
      return { side: 'Left', offset: extra }
    case 5:
    case 7:
    case 11:
    case 12:
      return { side: 'Right', offset: extra }
    case 2:
      return { side: 'Left', offset: extra - 1429.2 }
    case 6:
      return { side: 'Right', offset: extra + 1429.2 }
    case 0:
    case 4:
    case 10:
    default:
      return { side: 'Center', offset: extra }
  }
}

/** PJSK `CharacterLayoutMode`：3=Three，其余=Normal（SSE 的 `layout_mode`）。 */
export function layoutModeOf(value) {
  return Number(value) === 3 ? 'Three' : 'Normal'
}

/** PJSK `MoveSpeedType`：1=Fast、2=Slow，其余（0）=Normal。 */
export function speedOf(value) {
  switch (Number(value)) {
    case 1:
      return 'Fast'
    case 2:
      return 'Slow'
    default:
      return 'Normal'
  }
}

/**
 * EffectType 29~36 → SideFade。
 * 29 LeftIn / 30 LeftOut / 31 RightIn / 32 RightOut /
 * 33 TopIn / 34 TopOut / 35 BottomIn / 36 BottomOut。
 */
export function sideFadeOf(type) {
  const value = Number(type)
  const edge = value <= 30 ? 'left' : value <= 32 ? 'right' : value <= 34 ? 'top' : 'bottom'
  return { edge, mode: value % 2 === 0 ? 'out' : 'in' }
}

/** 表情名 → Irodori 情绪标签（用于逐句换参考音频） */
function emotionOf(facial) {
  const name = String(facial || '').toLowerCase()
  if (/cry|sad|ossad/.test(name)) return '伤心'
  if (/angry|osangry/.test(name)) return '生气'
  if (/smile|happy/.test(name)) return '开心'
  if (/shy|blush/.test(name)) return '害羞'
  if (/surprise|shock/.test(name)) return '惊讶'
  return '平静'
}

const TALK_LINE_WIDTH_UNITS = 26
const charWidthUnits = (char) => (char.codePointAt(0) >= 0x2e80 ? 1 : 0.5)

/** 与宿主 sanitizeDisplayText 相同的 26 字宽折行：渲染端只按空格折行，中文长句需要预折。 */
function wrapDisplayText(text) {
  const cleaned = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (!cleaned) return ''
  const lines = []
  for (const rawSegment of cleaned.split('\n')) {
    const segment = rawSegment.trim()
    if (!segment) continue
    let width = 0
    let current = []
    for (const char of segment) {
      const charWidth = charWidthUnits(char)
      if (current.length > 0 && width + charWidth > TALK_LINE_WIDTH_UNITS) {
        lines.push(current.join(''))
        current = [char]
        width = charWidth
      } else {
        current.push(char)
        width += charWidth
      }
    }
    if (current.length > 0) lines.push(current.join(''))
  }
  return lines.join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const scenario = readJson(args.scenario)
  const config = readJson(args.config)
  const translation = args.translation ? readJson(args.translation) : null
  const episodeTranslation =
    translation && args.episode ? translation.episodes?.[String(args.episode)] : null
  const talkMap = episodeTranslation?.talkData || {}

  const translate = (text) => {
    if (typeof text !== 'string') return ''
    return talkMap[text] ?? talkMap[text.trim()] ?? text
  }

  const imageIds = new Map(Object.entries(config.images || {}).map(([file, id]) => [file, id]))
  let nextImageId = Math.max(0, ...imageIds.values()) + 1
  const imageId = (name) => {
    const file = /\.(webp|png|jpe?g)$/i.test(name) ? name : `${name}.webp`
    if (!imageIds.has(file)) imageIds.set(file, nextImageId++)
    return imageIds.get(file)
  }

  const models = new Map(
    Object.entries(config.models).map(([id, model]) => [Number(id), { ...model, id: Number(id) }])
  )
  const currentModel = new Map()
  const resolveModel = (character2dId, costume) => {
    const entry = config.characterModels?.[String(character2dId)]
    if (!entry) throw new Error(`no model mapping for Character2dId ${character2dId}`)
    if (costume && entry.costumes?.[costume])
      currentModel.set(character2dId, entry.costumes[costume])
    if (!currentModel.has(character2dId)) currentModel.set(character2dId, entry.default)
    return currentModel.get(character2dId)
  }

  const snippets = []
  const usedModels = new Set()
  const bgmSnippetByIndex = new Map()

  const push = (snippet) => {
    snippets.push(snippet)
    return snippets.length - 1
  }

  push({
    type: 'ChangeLayoutMode',
    wait: false,
    delay: 0,
    data: { mode: layoutModeOf(scenario.FirstCharacterLayoutMode) }
  })
  push({
    type: 'ChangeBackgroundImage',
    wait: false,
    delay: 0,
    data: { imageId: imageId(scenario.FirstBackground) }
  })
  if (scenario.FirstBgm && scenario.FirstBgm !== 'bgm00000') {
    push({
      type: 'ChangeBgm',
      wait: false,
      delay: 0,
      data: { file: `${scenario.FirstBgm}.mp3`, fadeMs: 600 }
    })
  }

  let lastBgmSnippet = -1

  const addMotion = (modelId, motion, facial) => {
    usedModels.add(modelId)
    return {
      at: 0,
      modelId,
      ...(motion ? { motion } : {}),
      ...(facial ? { facial } : {})
    }
  }

  for (const snippet of scenario.Snippets) {
    const wait = snippet.ProgressBehavior === 1
    const delay = Number(snippet.Delay) || 0

    switch (snippet.Action) {
      case 1: {
        const talk = scenario.TalkData[snippet.ReferenceIndex]
        if (!talk) break
        const character2dId = talk.TalkCharacters?.[0]?.Character2dId
        const modelId = resolveModel(character2dId, '')
        const actions = (talk.Motions || [])
          .map((motion) => {
            const motionModel = resolveModel(motion.Character2dId, '')
            if (!motion.MotionName && !motion.FacialName) return null
            return addMotion(motionModel, motion.MotionName, motion.FacialName)
          })
          .filter(Boolean)
        const speakerFacial = talk.Motions?.[0]?.FacialName || ''
        push({
          type: 'Talk',
          wait,
          delay,
          data: {
            speaker: translate(talk.WindowDisplayName) || talk.WindowDisplayName,
            content: wrapDisplayText(translate(talk.Body)),
            ttsText: talk.Body,
            modelId,
            emotion: emotionOf(speakerFacial),
            ...(actions.length > 0 ? { actions } : {})
          }
        })
        break
      }
      case 2:
      case 4: {
        const layout = scenario.LayoutData[snippet.ReferenceIndex]
        if (!layout) break
        const modelId = resolveModel(layout.Character2dId, layout.CostumeType)
        if (snippet.Action === 4 || layout.Type === 0) {
          if (!layout.MotionName && !layout.FacialName) break
          usedModels.add(modelId)
          // 官方 ChangeMotion 在 type 分支前启动动作，协程本身立即结束；即使
          // ProgressBehavior=1 也不等剪辑播完。用 0.1s 的 actions 序列表达“只发 cue”，
          // 避免旧标量 Motion 把整段 1~4s 动作当成阻塞时间。
          push({
            type: 'Motion',
            wait,
            delay,
            data: {
              modelId,
              duration: 0.1,
              actions: [addMotion(modelId, layout.MotionName || '', layout.FacialName || '')]
            }
          })
          break
        }
        if (layout.Type === 2) {
          usedModels.add(modelId)
          push({
            type: 'LayoutAppear',
            wait,
            delay,
            data: {
              modelId,
              from: sideOf(layout.SideFrom, layout.SideFromOffsetX),
              to: sideOf(layout.SideTo, layout.SideToOffsetX),
              motion: layout.MotionName || '',
              facial: layout.FacialName || '',
              moveSpeed: speedOf(layout.MoveSpeedType)
            }
          })
        } else if (layout.Type === 3) {
          usedModels.add(modelId)
          push({
            type: 'LayoutClear',
            wait,
            delay,
            data: {
              modelId,
              from: sideOf(layout.SideFrom, layout.SideFromOffsetX),
              to: sideOf(layout.SideTo, layout.SideToOffsetX),
              moveSpeed: speedOf(layout.MoveSpeedType)
            }
          })
        } else if (layout.Type === 1) {
          usedModels.add(modelId)
          push({
            type: 'Move',
            wait,
            delay,
            data: {
              modelId,
              from: sideOf(layout.SideFrom, layout.SideFromOffsetX),
              to: sideOf(layout.SideTo, layout.SideToOffsetX),
              moveSpeed: speedOf(layout.MoveSpeedType),
              motion: layout.MotionName || '',
              facial: layout.FacialName || ''
            }
          })
        }
        break
      }
      case 6: {
        const effect = scenario.SpecialEffectData[snippet.ReferenceIndex]
        if (!effect) break
        const durationMs = Math.round((Number(effect.Duration) || 0) * 1000)
        switch (Number(effect.EffectType)) {
          case 1:
            push({ type: 'BlackIn', wait, delay, data: { duration: durationMs, color: 'black' } })
            break
          case 2:
            push({ type: 'HideTalk', wait: true, delay: 0 })
            push({ type: 'BlackOut', wait, delay, data: { duration: durationMs, color: 'black' } })
            break
          case 3:
            push({ type: 'BlackIn', wait, delay, data: { duration: durationMs, color: 'white' } })
            break
          case 4:
            push({ type: 'HideTalk', wait: true, delay: 0 })
            push({ type: 'BlackOut', wait, delay, data: { duration: durationMs, color: 'white' } })
            break
          case 5:
            push({ type: 'ShakeScreen', wait, delay, data: { duration: durationMs } })
            break
          case 6:
            // ShakeWindow：宿主只有一个全屏震屏实现，按 ShakeScreen 近似。
            push({ type: 'ShakeScreen', wait, delay, data: { duration: durationMs } })
            break
          case 7:
            push({
              type: 'ChangeBackgroundImage',
              wait,
              delay,
              data: { imageId: imageId(effect.StringValSub || effect.StringVal) }
            })
            break
          case 8:
            // ScenarioTelopPlayer：文本本身是 StringVal。
            push({ type: 'Telop', wait, delay, data: { content: effect.StringVal || '' } })
            break
          case 18:
            // PlaceInfo：地点标题，用 Telop 近似。
            push({ type: 'Telop', wait, delay, data: { content: effect.StringVal || '' } })
            break
          case 9:
            push({
              type: 'FlashbackIn',
              wait,
              delay,
              data: { duration: Math.max(100, durationMs), alpha: 0.3 }
            })
            break
          case 10:
            push({
              type: 'FlashbackOut',
              wait,
              delay,
              data: { duration: Math.max(100, durationMs) }
            })
            break
          case 12:
            push({ type: 'AmbientColor', wait, delay, data: { mode: 'normal' } })
            break
          case 13:
            push({ type: 'AmbientColor', wait, delay, data: { mode: 'evening' } })
            break
          case 14:
            push({ type: 'AmbientColor', wait, delay, data: { mode: 'night' } })
            break
          case 20:
          case 21:
          case 40:
          case 41:
            // SekaiTransition：偶数 = In（覆盖），奇数 = Out（露出）。
            push({
              type: 'Wipe',
              wait,
              delay,
              data: {
                mode: Number(effect.EffectType) % 2 === 0 ? 'in' : 'out',
                direction: 'right',
                duration: durationMs
              }
            })
            break
          case 25:
          case 26:
            push({ type: 'StopShake', wait, delay })
            break
          case 29:
          case 30:
          case 31:
          case 32:
          case 33:
          case 34:
          case 35:
          case 36: {
            const { edge, mode } = sideFadeOf(effect.EffectType)
            push({ type: 'SideFade', wait, delay, data: { edge, mode, duration: durationMs } })
            break
          }
          case 38:
          case 39:
            // BlurIn/BlurOut：宿主用背景模糊开关近似。
            push({
              type: 'BackgroundBlur',
              wait,
              delay,
              data: { enabled: Number(effect.EffectType) === 38 }
            })
            break
          case 44:
            push({
              type: 'BackgroundBlur',
              wait,
              delay,
              data: { enabled: /^(1|true|on)$/i.test(String(effect.StringVal || '')) }
            })
            break
          case 42: {
            const [x, y] = String(effect.StringVal || '0, 0')
              .split(',')
              .map((value) => Number.parseFloat(value) || 0)
            push({
              type: 'CameraMove',
              wait,
              delay,
              data: { x, y, duration: durationMs }
            })
            break
          }
          case 43:
            push({
              type: 'CameraZoom',
              wait,
              delay,
              data: { scale: Number.parseFloat(effect.StringVal) || 1, duration: durationMs }
            })
            break
          default:
            console.warn(`skip effect type ${effect.EffectType} (snippet ${snippet.Index})`)
        }
        break
      }
      case 8: {
        const mode =
          scenario.ScenarioSnippetCharacterLayoutModes?.[snippet.ReferenceIndex]
            ?.CharacterLayoutMode
        push({
          type: 'ChangeLayoutMode',
          wait,
          delay,
          data: { mode: layoutModeOf(mode) }
        })
        break
      }
      case 7: {
        const sound = scenario.SoundData[snippet.ReferenceIndex]
        if (!sound) break
        const fadeMs = Math.round((Number(sound.Duration) || 0) * 1000)
        if (Number(sound.PlayMode) === 4) {
          const target = snippets[lastBgmSnippet]
          if (target && target.type === 'ChangeBgm') {
            target.data.volume = Number(sound.Volume) || 1
          }
        } else if (sound.Bgm === 'bgm00000') {
          push({
            type: 'ChangeBgm',
            wait,
            delay,
            data: { stop: true, fadeMs }
          })
          lastBgmSnippet = -1
        } else if (sound.Bgm) {
          lastBgmSnippet = push({
            type: 'ChangeBgm',
            wait,
            delay,
            data: { file: `${sound.Bgm}.mp3`, fadeMs, volume: Number(sound.Volume) || 1 }
          })
        } else if (sound.Se) {
          if (Number(sound.PlayMode) === 3) {
            push({
              type: 'StopSe',
              wait,
              delay,
              data: { file: `${sound.Se}.mp3`, fadeMs }
            })
          } else {
            push({
              type: 'PlaySe',
              wait,
              delay,
              data: {
                file: `${sound.Se}.mp3`,
                volume: Number(sound.Volume) || 1,
                loop: Number(sound.PlayMode) === 2,
                fadeMs
              }
            })
          }
        }
        break
      }
      case 0: {
        // Action 0 = 播完收尾；把收尾 delay 并进最后一段淡出，避免片尾提前结束
        const tailMs = Math.round((Number(snippet.Delay) || 0) * 1000)
        if (tailMs > 0) {
          for (let i = snippets.length - 1; i >= 0; i--) {
            if (snippets[i].type === 'BlackOut') {
              snippets[i].data.duration += tailMs
              break
            }
          }
        }
        break
      }
      default:
        if (snippet.Action !== 0) {
          console.warn(`skip action ${snippet.Action} (snippet ${snippet.Index})`)
        }
    }
  }

  const story = {
    models: [...usedModels]
      .sort((a, b) => a - b)
      .map((id) => {
        const model = models.get(id)
        if (!model) throw new Error(`model id ${id} is not in config.models`)
        return {
          id,
          model: model.path,
          ...(Number.isFinite(model.normal_scale) ? { normal_scale: model.normal_scale } : {})
        }
      }),
    images: [...imageIds.entries()].map(([file, id]) => ({ id, image: file })),
    snippets
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, `${JSON.stringify(story, null, 2)}\n`)

  const counts = {}
  for (const snippet of snippets) counts[snippet.type] = (counts[snippet.type] || 0) + 1
  console.log(`written ${args.out}`)
  console.log(`models: ${story.models.map((m) => m.id).join(', ')}`)
  console.log(`images: ${story.images.map((i) => i.image).join(', ')}`)
  console.log(`snippets: ${snippets.length} ${JSON.stringify(counts)}`)
  if (args.dump) {
    snippets.forEach((snippet, index) => {
      const body = snippet.data?.content || snippet.data?.file || snippet.data?.mode || ''
      console.log(`${index}\t${snippet.type}\tdelay=${snippet.delay}\t${String(body).slice(0, 40)}`)
    })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
