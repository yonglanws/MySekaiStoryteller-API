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
 * LeftInside 与 Left、RightInside 与 Right 的 x 相同；LeftOver/RightOver 与
 * *Under 标记直接透传给 StageUtils / StorySchema。
 */
export function sideOf(side, offset) {
  const extra = Number(offset) || 0
  switch (Number(side)) {
    case 1:
    case 3:
      return { side: 'Left', offset: extra }
    case 2:
      return { side: 'LeftOver', offset: extra }
    case 5:
    case 7:
      return { side: 'Right', offset: extra }
    case 6:
      return { side: 'RightOver', offset: extra }
    case 8:
    case 9:
      return { side: 'Left', offset: extra, under: true }
    case 10:
      return { side: 'Center', offset: extra, under: true }
    case 11:
    case 12:
      return { side: 'Right', offset: extra, under: true }
    case 0:
    case 4:
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

const TALK_LINE_WIDTH_UNITS = 30
const charWidthUnits = (char) => (char.codePointAt(0) >= 0x2e80 ? 1 : 0.5)

/** 官方 1368.3px 文本框对应的 30 字宽折行：渲染端按空格/换行排版，中文长句需要预折。 */
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
  const currentCostume = new Map()
  const hasMappedCostume = (character2dId, costume) => {
    const entry = config.characterModels?.[String(character2dId)]
    return Boolean(costume && entry?.costumes?.[costume])
  }
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

  const push = (snippet) => {
    snippets.push(snippet)
    return snippets.length - 1
  }

  const depthOf = (value) => {
    switch (Number(value)) {
      case 1:
        return 'Front'
      case 2:
        return 'Back'
      case 3:
        return 'Reset'
      default:
        return null
    }
  }

  const parseDollyParams = (raw) => {
    let zoom = null
    let blur = null
    let dist = null
    for (const part of String(raw || '')
      .replace(/：/g, ':')
      .split(',')) {
      const idx = part.indexOf(':')
      if (idx < 0) continue
      const key = part.slice(0, idx).trim().toLowerCase()
      const value = Number.parseFloat(part.slice(idx + 1).trim())
      if (!Number.isFinite(value)) continue
      if (key === 'zoom') zoom = value
      else if (key === 'blur') blur = value
      else if (key === 'dist') dist = value
    }
    return { zoom, blur, dist }
  }

  push({
    type: 'ChangeLayoutMode',
    wait: false,
    progressBehavior: 'Now',
    delay: 0,
    data: { mode: layoutModeOf(scenario.FirstCharacterLayoutMode) }
  })
  push({
    type: 'ChangeBackgroundImage',
    wait: false,
    progressBehavior: 'Now',
    delay: 0,
    data: { imageId: imageId(scenario.FirstBackground) }
  })
  if (scenario.FirstBgm && scenario.FirstBgm !== 'bgm00000') {
    push({
      type: 'ChangeBgm',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { file: `${scenario.FirstBgm}.mp3`, fadeMs: 600 }
    })
  }

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
    const progressBehavior = Number(snippet.ProgressBehavior) === 1 ? 'WaitFinished' : 'Now'
    const wait = progressBehavior === 'WaitFinished'
    const delay = Number(snippet.Delay) || 0

    switch (snippet.Action) {
      case 1: {
        const talk = scenario.TalkData[snippet.ReferenceIndex]
        if (!talk) break
        const character2dId = talk.TalkCharacters?.[0]?.Character2dId
        const modelId = resolveModel(character2dId, '')
        // 旁白/观众等没有动作的台词也要把说话模型带进 story.models，
        // 否则渲染端会在解析 Talk.modelId 时报 "Model with id N not found"。
        usedModels.add(modelId)
        const actions = (talk.Motions || [])
          .map((motion) => {
            const motionModel = resolveModel(motion.Character2dId, '')
            if (!motion.MotionName && !motion.FacialName) return null
            return addMotion(motionModel, motion.MotionName, motion.FacialName)
          })
          .filter(Boolean)
        const speakerFacial = talk.Motions?.[0]?.FacialName || ''
        const talkEffect =
          Number(talk.RequirePlayEffect) === 1
            ? 'Internal'
            : Number(talk.RequirePlayEffect) === 2
              ? 'Overlap'
              : undefined
        push({
          type: 'Talk',
          wait,
          progressBehavior,
          delay,
          data: {
            speaker: translate(talk.WindowDisplayName) || talk.WindowDisplayName,
            content: wrapDisplayText(translate(talk.Body)),
            ttsText: talk.Body,
            // 打字机按官方日文 body 计时；译文 content 只负责显示。
            typingText: talk.Body,
            modelId,
            emotion: emotionOf(speakerFacial),
            ...(talk.WhenFinishCloseWindow ? { closeWindowOnFinish: true } : {}),
            ...(talkEffect ? { effect: talkEffect } : {}),
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
        usedModels.add(modelId)
        const maybeEmitCostumeChange = () => {
          const costume = String(layout.CostumeType || '').trim()
          if (!costume || hasMappedCostume(layout.Character2dId, costume)) return
          if (currentCostume.get(modelId) === costume) return
          currentCostume.set(modelId, costume)
          push({
            type: 'CostumeChange',
            wait: false,
            progressBehavior: 'Now',
            delay,
            data: { modelId, costume }
          })
        }
        if (snippet.Action === 4 || layout.Type === 0) {
          maybeEmitCostumeChange()
          if (!layout.MotionName && !layout.FacialName) break
          // 官方 ChangeMotion 在 type 分支前启动动作，协程本身立即结束；即使
          // ProgressBehavior=1 也不等剪辑播完。用 0.1s 的 actions 序列表达“只发 cue”，
          // 避免旧标量 Motion 把整段 1~4s 动作当成阻塞时间。
          push({
            type: 'Motion',
            wait,
            progressBehavior,
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
          maybeEmitCostumeChange()
          push({
            type: 'LayoutAppear',
            wait,
            progressBehavior,
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
          const appearDepth = depthOf(layout.DepthType)
          if (appearDepth === 'Front' || appearDepth === 'Back') {
            push({
              type: 'LayoutDepth',
              wait: false,
              progressBehavior: 'Now',
              delay,
              data: { modelId, depth: appearDepth }
            })
          }
        } else if (layout.Type === 3) {
          maybeEmitCostumeChange()
          push({
            type: 'LayoutClear',
            wait,
            progressBehavior,
            delay,
            data: {
              modelId,
              from: sideOf(layout.SideFrom, layout.SideFromOffsetX),
              to: sideOf(layout.SideTo, layout.SideToOffsetX),
              moveSpeed: speedOf(layout.MoveSpeedType)
            }
          })
        } else if (layout.Type === 1) {
          maybeEmitCostumeChange()
          push({
            type: 'Move',
            wait,
            progressBehavior,
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
        } else if (layout.Type === 4 || layout.Type === 5) {
          maybeEmitCostumeChange()
          if (layout.MotionName || layout.FacialName) {
            push({
              type: 'Motion',
              wait: false,
              progressBehavior: 'Now',
              delay,
              data: {
                modelId,
                duration: 0.1,
                actions: [addMotion(modelId, layout.MotionName || '', layout.FacialName || '')]
              }
            })
          }
          push({
            type: 'CharacterShake',
            wait,
            progressBehavior,
            delay,
            data: { modelId, axis: layout.Type === 4 ? 'X' : 'Y' }
          })
        } else if (layout.Type === 6) {
          maybeEmitCostumeChange()
          if (layout.MotionName || layout.FacialName) {
            push({
              type: 'Motion',
              wait: false,
              progressBehavior: 'Now',
              delay,
              data: {
                modelId,
                duration: 0.1,
                actions: [addMotion(modelId, layout.MotionName || '', layout.FacialName || '')]
              }
            })
          }
          const depth = depthOf(layout.DepthType) || 'Reset'
          push({
            type: 'LayoutDepth',
            wait,
            progressBehavior,
            delay,
            data: { modelId, depth }
          })
        }
        break
      }
      case 6: {
        const effect = scenario.SpecialEffectData[snippet.ReferenceIndex]
        if (!effect) break
        const durationMs = Math.round((Number(effect.Duration) || 0) * 1000)
        const effectType = Number(effect.EffectType)
        switch (effectType) {
          case 0:
          case 11:
          case 17:
            // 官方 Noop / 等候占位指令
            break
          case 1:
            push({
              type: 'BlackIn',
              wait,
              progressBehavior,
              delay,
              data: { duration: durationMs, color: 'black' }
            })
            break
          case 2:
            push({
              type: 'HideTalk',
              wait: true,
              progressBehavior: 'WaitFinished',
              delay: 0
            })
            push({
              type: 'BlackOut',
              wait,
              progressBehavior,
              delay,
              data: { duration: durationMs, color: 'black' }
            })
            break
          case 3:
            push({
              type: 'BlackIn',
              wait,
              progressBehavior,
              delay,
              data: { duration: durationMs, color: 'white' }
            })
            break
          case 4:
            push({
              type: 'HideTalk',
              wait: true,
              progressBehavior: 'WaitFinished',
              delay: 0
            })
            push({
              type: 'BlackOut',
              wait,
              progressBehavior,
              delay,
              data: { duration: durationMs, color: 'white' }
            })
            break
          case 5:
            // 官方用 9999 秒表示“一直抖到 StopShakeScreen”；schema 上限为 30s。
            push({
              type: 'ShakeScreen',
              wait,
              progressBehavior,
              delay,
              data: { duration: Math.min(durationMs, 30000) }
            })
            break
          case 6:
            push({
              type: 'ShakeWindow',
              wait,
              progressBehavior,
              delay,
              data: { duration: Math.min(durationMs, 30000) }
            })
            break
          case 7:
            push({
              type: 'ChangeBackgroundImage',
              wait,
              progressBehavior,
              delay,
              data: {
                imageId: imageId(effect.StringValSub || effect.StringVal),
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 30000) } : {})
              }
            })
            break
          case 8:
            push({
              type: 'Telop',
              wait,
              progressBehavior,
              delay,
              data: { content: translate(effect.StringVal || '') || effect.StringVal || '' }
            })
            break
          case 18:
            push({
              type: 'PlaceInfo',
              wait,
              progressBehavior,
              delay,
              data: {
                text: translate(effect.StringVal || '') || effect.StringVal || '',
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 30000) } : {})
              }
            })
            break
          case 9:
            push({
              type: 'FlashbackIn',
              wait,
              progressBehavior,
              delay,
              data: { duration: Math.min(Math.max(100, durationMs), 10000), alpha: 0.3 }
            })
            break
          case 10:
            push({
              type: 'FlashbackOut',
              wait,
              progressBehavior,
              delay,
              data: { duration: Math.min(Math.max(100, durationMs), 10000) }
            })
            break
          case 12:
            push({
              type: 'AmbientColor',
              wait,
              progressBehavior,
              delay,
              data: { mode: 'normal' }
            })
            break
          case 13:
            push({
              type: 'AmbientColor',
              wait,
              progressBehavior,
              delay,
              data: { mode: 'evening' }
            })
            break
          case 14:
            push({
              type: 'AmbientColor',
              wait,
              progressBehavior,
              delay,
              data: { mode: 'night' }
            })
            break
          case 15:
            push({
              type: 'PlayScenarioEffect',
              wait,
              progressBehavior,
              delay,
              data: {
                effectName: effect.StringVal || effect.StringValSub || '',
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 30000) } : {})
              }
            })
            break
          case 16:
            push({
              type: 'StopScenarioEffect',
              wait,
              progressBehavior,
              delay,
              data: {
                effectName: effect.StringVal || effect.StringValSub || '',
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 30000) } : {})
              }
            })
            break
          case 19:
            push({
              type: 'Movie',
              wait,
              progressBehavior,
              delay,
              data: {
                file: effect.StringVal || '',
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 600000) } : {})
              }
            })
            break
          case 20:
          case 21:
          case 40:
          case 41:
            push({
              type: effectType % 2 === 0 ? 'SekaiIn' : 'SekaiOut',
              wait,
              progressBehavior,
              delay,
              data: {
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 30000) } : {}),
                variant: effectType >= 40 ? 'v2' : 'v1'
              }
            })
            break
          case 22: {
            const rawShader = String(effect.StringVal || '')
              .trim()
              .toLowerCase()
            if (!['hologram', 'monitor', 'blur', 'none'].includes(rawShader)) break
            const charId = Number(effect.IntVal)
            const hasChar = Number.isFinite(charId) && config.characterModels?.[String(charId)]
            const shaderLevel = Number.parseFloat(effect.StringValSub)
            const levelOption =
              rawShader === 'blur' && Number.isFinite(shaderLevel)
                ? { level: Math.min(3, Math.max(1, shaderLevel)) }
                : {}
            if (hasChar) {
              const targetModel = resolveModel(charId, '')
              usedModels.add(targetModel)
              push({
                type: 'AttachCharacterShader',
                wait,
                progressBehavior,
                delay,
                data: { modelId: targetModel, shader: rawShader, ...levelOption }
              })
            } else if (rawShader === 'none') {
              const fallbackIds =
                usedModels.size > 0 ? [...usedModels] : [...models.keys()].slice(0, 1)
              for (const targetModel of fallbackIds) {
                usedModels.add(targetModel)
                push({
                  type: 'AttachCharacterShader',
                  wait,
                  progressBehavior,
                  delay,
                  data: { modelId: targetModel, shader: 'none' }
                })
              }
            }
            break
          }
          case 23:
            push({
              type: 'SimpleSelectable',
              wait,
              progressBehavior,
              delay,
              data: {
                choices: String(effect.StringVal || '')
                  .split('/')
                  .map((choice) => translate(choice) || choice)
              }
            })
            break
          case 24:
            push({
              type: 'FullScreenText',
              wait,
              progressBehavior,
              delay,
              data: {
                text: translate(effect.StringVal || '') || effect.StringVal || '',
                ...(effect.StringValSub ? { voice: effect.StringValSub } : {}),
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 120000) } : {})
              }
            })
            break
          case 25:
            push({ type: 'StopShakeScreen', wait, progressBehavior, delay, data: {} })
            break
          case 26:
            push({ type: 'StopShakeWindow', wait, progressBehavior, delay, data: {} })
            break
          case 27:
            push({
              type: 'SepiaIn',
              wait,
              progressBehavior,
              delay,
              data: durationMs > 0 ? { duration: Math.min(durationMs, 30000) } : {}
            })
            break
          case 28:
            push({
              type: 'SepiaOut',
              wait,
              progressBehavior,
              delay,
              data: durationMs > 0 ? { duration: Math.min(durationMs, 30000) } : {}
            })
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
            push({
              type: 'SideFade',
              wait,
              progressBehavior,
              delay,
              data: {
                edge,
                direction: `${edge[0].toUpperCase()}${edge.slice(1)}`,
                mode: mode === 'in' ? 'In' : 'Out',
                duration: Math.min(durationMs, 10000)
              }
            })
            break
          }
          case 37:
            console.warn(`skip unsupported 3D MV effect type 37 (snippet ${snippet.Index})`)
            break
          case 38:
            push({
              type: 'BlurIn',
              wait,
              progressBehavior,
              delay,
              data: { duration: Math.min(durationMs, 30000) }
            })
            break
          case 39:
            push({
              type: 'BlurOut',
              wait,
              progressBehavior,
              delay,
              data: { duration: Math.min(durationMs, 30000) }
            })
            break
          case 44: {
            const enabled = /^(1|true|on)$/i.test(String(effect.StringVal || ''))
            push({
              type: 'BackgroundBlur',
              wait,
              progressBehavior,
              delay,
              data: {
                mode: enabled ? 'In' : 'Out',
                enabled,
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 10000) } : {})
              }
            })
            break
          }
          case 42: {
            const [x, y] = String(effect.StringVal || '0, 0')
              .split(',')
              .map((value) => Number.parseFloat(value) || 0)
            push({
              type: 'CameraMove',
              wait,
              progressBehavior,
              delay,
              data: {
                x,
                y,
                duration: Math.min(durationMs, 30000),
                ...(effect.StringValSub ? { ease: effect.StringValSub } : {})
              }
            })
            break
          }
          case 43:
            push({
              type: 'CameraZoom',
              wait,
              progressBehavior,
              delay,
              data: {
                scale: Number.parseFloat(effect.StringVal) || 1,
                duration: Math.min(durationMs, 30000),
                ...(effect.StringValSub ? { ease: effect.StringValSub } : {})
              }
            })
            break
          case 45: {
            const { zoom } = parseDollyParams(effect.StringVal)
            const safeZoom = Number.isFinite(zoom) && zoom > 0 ? Math.min(zoom, 10) : 1
            push({
              type: 'DollyZoom',
              wait,
              progressBehavior,
              delay,
              data: {
                duration: Math.min(durationMs, 30000),
                zoom: safeZoom,
                ...(effect.StringValSub ? { ease: effect.StringValSub } : {})
              }
            })
            break
          }
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
          progressBehavior,
          delay,
          data: { mode: layoutModeOf(mode) }
        })
        break
      }
      case 7: {
        const sound = scenario.SoundData[snippet.ReferenceIndex]
        if (!sound) break
        const playMode = Number(sound.PlayMode) || 0
        const fadeMs = Math.round((Number(sound.Duration) || 0) * 1000)
        const volume = Number.isFinite(Number(sound.Volume)) ? Number(sound.Volume) : 1
        if (playMode === 4) {
          push({
            type: 'BgmVolume',
            wait,
            progressBehavior,
            delay,
            data: {
              volume: Math.min(2, Math.max(0, volume)),
              duration: Math.min(Math.max(0, fadeMs), 30000)
            }
          })
          break
        }
        if (playMode === 3) {
          if (sound.Se) {
            push({
              type: 'StopSe',
              wait,
              progressBehavior,
              delay,
              data: { file: `${sound.Se}.mp3`, fadeMs: Math.min(Math.max(0, fadeMs), 10000) }
            })
          }
          if (sound.Bgm) {
            push({
              type: 'ChangeBgm',
              wait,
              progressBehavior,
              delay,
              data: { stop: true, fadeMs: Math.max(0, fadeMs) }
            })
          }
          break
        }
        if (sound.Bgm === 'bgm00000') {
          push({
            type: 'ChangeBgm',
            wait,
            progressBehavior,
            delay,
            data: { stop: true, fadeMs: Math.max(0, fadeMs) }
          })
        } else if (sound.Bgm) {
          push({
            type: 'ChangeBgm',
            wait,
            progressBehavior,
            delay,
            data: { file: `${sound.Bgm}.mp3`, fadeMs: Math.max(0, fadeMs), volume }
          })
        }
        if (sound.Se) {
          const isLoop = playMode === 2
          const deferredSec = !isLoop ? Math.max(0, Number(sound.Duration) || 0) : 0
          push({
            type: 'PlaySe',
            wait,
            progressBehavior,
            delay: delay + deferredSec,
            data: {
              file: `${sound.Se}.mp3`,
              volume,
              loop: isLoop,
              fadeMs: isLoop ? Math.min(Math.max(0, fadeMs), 10000) : 0
            }
          })
        }
        break
      }
      case 0: {
        // Action 0 = 播完收尾。官方时间线把它作为独立的 wait 节点，排在最后一段
        // 淡出之后；不能把 delay 并进 BlackOut，否则 25s 淡出会被拉成 29s。
        const tailMs = Math.round((Number(snippet.Delay) || 0) * 1000)
        if (tailMs > 0) {
          push({
            type: 'Wait',
            wait: true,
            progressBehavior: 'WaitFinished',
            delay: 0,
            data: { duration: tailMs }
          })
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

  // 渲染端要求每个被引用的 modelId 都在 story.models 里；转换阶段就自检，
  // 避免导出跑起来才报 "Model with id N not found"。
  const declaredModels = new Set(story.models.map((model) => model.id))
  const referencedModels = new Set()
  const collectModelIds = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(collectModelIds)
      return
    }
    if (Number.isFinite(value.modelId)) referencedModels.add(value.modelId)
    Object.values(value).forEach(collectModelIds)
  }
  snippets.forEach(collectModelIds)
  const missingModels = [...referencedModels].filter((id) => !declaredModels.has(id))
  if (missingModels.length > 0) {
    throw new Error(
      `snippets reference models missing from story.models: ${missingModels.join(', ')}`
    )
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
