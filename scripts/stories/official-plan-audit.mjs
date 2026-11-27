/**
 * 官方剧情语料批量审计。
 *
 * 目标不是再写一个播放器，而是把 328 集日服 scenario 映射成本项目的 snippets 后，
 * 逐集跑 `calculateTimeline + bakeStoryPlan`，用真实官方数据检查：
 * - Talk 打字 4 帧/字、无语音 +120 帧、首句窗口 12 帧；
 * - Talk 内动作 cue 固定在句首（官方 MotionChangeFrom/TimingSyncValue 语义）；
 * - Appear 1 帧 alpha + 6 帧淡入；Clear 原地 15 帧 / 滑动 fade=move-6；
 * - Move 的 Slow/Normal/Fast/Immediate 帧数；
 * - 精确时长特效（WhiteIn 0.1s、Wipe 0.4s、Camera 0s）不再被 500ms 下限拉长；
 * - 每集 plan 与 timeline 的帧数、总帧数一致。
 *
 * 报告写到仓库外，避免把语料统计带进 git。
 *
 * 用法：
 *   node scripts/stories/official-plan-audit.mjs \
 *     --corpus /path/to/msst-ai-lab/corpus \
 *     --out /path/to/msst-ai-lab/official-plan-audit.json
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { layoutModeOf, sideFadeOf, sideOf, speedOf } from './pjsk-scenario.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

const DEFAULT_CORPUS =
  process.env.MSS_CORPUS_DIR ||
  process.env.MSST_CORPUS_ROOT ||
  process.env.MSS_CORPUS ||
  path.join(root, 'cache', 'official-corpus')
const DEFAULT_OUT =
  process.env.MSS_PLAN_AUDIT_OUT || path.join(root, 'cache', 'official-plan-audit.json')

/** 加载 renderer TS（不依赖浏览器），返回审计需要的纯函数。 */
export function loadAuditRuntime() {
  const context = vm.createContext({ console })
  const modules = new Map()
  const compiled = new Map()
  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(renderer, target)
    if (modules.has(filename)) return modules.get(filename)
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require) {\n${
            ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
              compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
              fileName: filename
            }).outputText
          }\n})`,
          { filename }
        )
      )
    }
    const exports = {}
    modules.set(filename, exports)
    const require = (name) => {
      if (!name.startsWith('.')) throw new Error(`Unexpected platform dependency: ${name}`)
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  const timeline = load('utils/TimelineCalculator.ts')
  const plan = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const timing = load(path.join(root, 'src/common/official/timing.ts'))
  const text = load(path.join(root, 'src/common/official/text.ts'))
  const sideFade = load(path.join(root, 'src/common/official/sideFade.ts'))
  return { timeline, plan, timing, text, sideFade }
}

function pushPortraitModel(models, id) {
  if (!Number.isFinite(Number(id))) return -1
  const numeric = Number(id)
  models.add(numeric)
  return numeric
}

function effectDurationMs(effect) {
  return Math.round((Number(effect.Duration) || 0) * 1000)
}

function depthOf(value) {
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

function parseDollyZoom(raw) {
  let zoom = null
  for (const part of String(raw || '')
    .replace(/：/g, ':')
    .split(',')) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    if (part.slice(0, idx).trim().toLowerCase() === 'zoom') {
      const value = Number.parseFloat(part.slice(idx + 1).trim())
      if (Number.isFinite(value)) zoom = value
    }
  }
  return Number.isFinite(zoom) && zoom > 0 ? Math.min(zoom, 10) : 1
}

/**
 * 把一集官方 scenario 映射成 StoryData.snippets。只做时间线相关的映射；
 * 资源路径、翻译、TTS 都不参与，保证审计可以完全离线跑完 328 集。
 */
export function mapOfficialEpisode(scenario) {
  const models = new Set()
  const snippets = []
  const stats = {
    talks: 0,
    motions: 0,
    appears: 0,
    clears: 0,
    moves: 0,
    effects: 0,
    sounds: 0,
    layoutModes: 0,
    skippedEffects: {},
    skippedActions: {},
    nonWait: 0
  }

  const push = (snippet) => {
    snippets.push(snippet)
    if (!snippet.wait) stats.nonWait++
    return snippet
  }
  const modelIdOf = (id) => pushPortraitModel(models, id)
  const addActions = (list) =>
    list
      .map((motion) => {
        if (!motion.MotionName && !motion.FacialName) return null
        stats.motions++
        return {
          at: 0,
          modelId: modelIdOf(motion.Character2dId),
          ...(motion.MotionName ? { motion: motion.MotionName } : {}),
          ...(motion.FacialName ? { facial: motion.FacialName } : {})
        }
      })
      .filter(Boolean)

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
    data: { imageId: 1 }
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

  for (const snippet of scenario.Snippets ?? []) {
    const progressBehavior = Number(snippet.ProgressBehavior) === 1 ? 'WaitFinished' : 'Now'
    const wait = progressBehavior === 'WaitFinished'
    const delay = Number(snippet.Delay) || 0
    switch (Number(snippet.Action)) {
      case 1: {
        const talk = scenario.TalkData?.[snippet.ReferenceIndex]
        if (!talk) break
        const modelId = modelIdOf(talk.TalkCharacters?.[0]?.Character2dId)
        const actions = addActions(talk.Motions ?? [])
        const talkEffect =
          Number(talk.RequirePlayEffect) === 1
            ? 'Internal'
            : Number(talk.RequirePlayEffect) === 2
              ? 'Overlap'
              : undefined
        stats.talks++
        push({
          type: 'Talk',
          wait,
          progressBehavior,
          delay,
          data: {
            speaker: talk.WindowDisplayName ?? '',
            content: talk.Body ?? '',
            ttsText: '',
            voice: '',
            modelId,
            ...(talk.WhenFinishCloseWindow ? { closeWindowOnFinish: true } : {}),
            ...(talkEffect ? { effect: talkEffect } : {}),
            ...(actions.length > 0 ? { actions } : {})
          }
        })
        break
      }
      case 2:
      case 4: {
        const layout = scenario.LayoutData?.[snippet.ReferenceIndex]
        if (!layout) break
        const modelId = modelIdOf(layout.Character2dId)
        const layoutType = Number(layout.Type)
        if (Number(snippet.Action) === 4 || layoutType === 0) {
          if (!layout.MotionName && !layout.FacialName) break
          // 官方 ChangeMotion 不等剪辑；0.1s actions 序列只发 cue。
          stats.motions++
          push({
            type: 'Motion',
            wait,
            progressBehavior,
            delay,
            data: {
              modelId,
              duration: 0.1,
              actions: [
                {
                  at: 0,
                  modelId,
                  ...(layout.MotionName ? { motion: layout.MotionName } : {}),
                  ...(layout.FacialName ? { facial: layout.FacialName } : {})
                }
              ]
            }
          })
          break
        }
        const base = {
          modelId,
          from: sideOf(layout.SideFrom, layout.SideFromOffsetX),
          to: sideOf(layout.SideTo, layout.SideToOffsetX),
          moveSpeed: speedOf(layout.MoveSpeedType)
        }
        if (layoutType === 2) {
          stats.appears++
          push({
            type: 'LayoutAppear',
            wait,
            progressBehavior,
            delay,
            data: {
              ...base,
              motion: layout.MotionName || '',
              facial: layout.FacialName || ''
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
        } else if (layoutType === 3) {
          stats.clears++
          push({
            type: 'LayoutClear',
            wait,
            progressBehavior,
            delay,
            data: {
              ...base,
              motion: layout.MotionName || '',
              facial: layout.FacialName || ''
            }
          })
        } else if (layoutType === 1) {
          stats.moves++
          push({
            type: 'Move',
            wait,
            progressBehavior,
            delay,
            data: {
              ...base,
              motion: layout.MotionName || '',
              facial: layout.FacialName || ''
            }
          })
        } else if (layoutType === 4 || layoutType === 5) {
          if (layout.MotionName || layout.FacialName) {
            stats.motions++
            push({
              type: 'Motion',
              wait: false,
              progressBehavior: 'Now',
              delay,
              data: {
                modelId,
                duration: 0.1,
                actions: [
                  {
                    at: 0,
                    modelId,
                    ...(layout.MotionName ? { motion: layout.MotionName } : {}),
                    ...(layout.FacialName ? { facial: layout.FacialName } : {})
                  }
                ]
              }
            })
          }
          push({
            type: 'CharacterShake',
            wait,
            progressBehavior,
            delay,
            data: { modelId, axis: layoutType === 4 ? 'X' : 'Y' }
          })
        } else if (layoutType === 6) {
          if (layout.MotionName || layout.FacialName) {
            stats.motions++
            push({
              type: 'Motion',
              wait: false,
              progressBehavior: 'Now',
              delay,
              data: {
                modelId,
                duration: 0.1,
                actions: [
                  {
                    at: 0,
                    modelId,
                    ...(layout.MotionName ? { motion: layout.MotionName } : {}),
                    ...(layout.FacialName ? { facial: layout.FacialName } : {})
                  }
                ]
              }
            })
          }
          push({
            type: 'LayoutDepth',
            wait,
            progressBehavior,
            delay,
            data: { modelId, depth: depthOf(layout.DepthType) || 'Reset' }
          })
        }
        break
      }
      case 6: {
        const effect = scenario.SpecialEffectData?.[snippet.ReferenceIndex]
        if (!effect) break
        const durationMs = effectDurationMs(effect)
        const type = Number(effect.EffectType)
        stats.effects++
        switch (type) {
          case 0:
          case 11:
          case 17:
          case 37:
            // 官方 Noop / 等候占位 / 不支持的 3D MV
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
            push({ type: 'HideTalk', wait: true, progressBehavior: 'WaitFinished', delay: 0 })
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
            push({ type: 'HideTalk', wait: true, progressBehavior: 'WaitFinished', delay: 0 })
            push({
              type: 'BlackOut',
              wait,
              progressBehavior,
              delay,
              data: { duration: durationMs, color: 'white' }
            })
            break
          case 5:
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
                imageId: 2,
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
              data: { content: effect.StringVal || '' }
            })
            break
          case 18:
            push({
              type: 'PlaceInfo',
              wait,
              progressBehavior,
              delay,
              data: {
                text: effect.StringVal || '',
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
          case 13:
          case 14:
            push({
              type: 'AmbientColor',
              wait,
              progressBehavior,
              delay,
              data: {
                mode: type === 12 ? 'normal' : type === 13 ? 'evening' : 'night'
              }
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
              type: type % 2 === 0 ? 'SekaiIn' : 'SekaiOut',
              wait,
              progressBehavior,
              delay,
              data: {
                ...(durationMs > 0 ? { duration: Math.min(durationMs, 30000) } : {}),
                variant: type >= 40 ? 'v2' : 'v1'
              }
            })
            break
          case 22: {
            const rawShader = String(effect.StringVal || '')
              .trim()
              .toLowerCase()
            const shader = ['hologram', 'monitor', 'blur', 'none'].includes(rawShader)
              ? rawShader
              : 'none'
            const shaderLevel = Number.parseFloat(effect.StringValSub)
            push({
              type: 'AttachCharacterShader',
              wait,
              progressBehavior,
              delay,
              data: {
                modelId: modelIdOf(effect.IntVal),
                shader,
                ...(shader === 'blur' && Number.isFinite(shaderLevel)
                  ? { level: Math.min(3, Math.max(1, shaderLevel)) }
                  : {})
              }
            })
            break
          }
          case 23:
            push({
              type: 'SimpleSelectable',
              wait,
              progressBehavior,
              delay,
              data: { choices: String(effect.StringVal || '').split('/') }
            })
            break
          case 24:
            push({
              type: 'FullScreenText',
              wait,
              progressBehavior,
              delay,
              data: {
                text: effect.StringVal || '',
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
            const fade = sideFadeOf(type)
            push({
              type: 'SideFade',
              wait,
              progressBehavior,
              delay,
              data: {
                edge: fade.edge,
                direction: `${fade.edge[0].toUpperCase()}${fade.edge.slice(1)}`,
                mode: fade.mode === 'in' ? 'In' : 'Out',
                duration: Math.min(durationMs, 10000)
              }
            })
            break
          }
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
              data: { x, y, duration: Math.min(durationMs, 30000) }
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
                duration: Math.min(durationMs, 30000)
              }
            })
            break
          case 45:
            push({
              type: 'DollyZoom',
              wait,
              progressBehavior,
              delay,
              data: {
                duration: Math.min(durationMs, 30000),
                zoom: parseDollyZoom(effect.StringVal)
              }
            })
            break
          default:
            stats.skippedEffects[type] = (stats.skippedEffects[type] ?? 0) + 1
        }
        break
      }
      case 7: {
        const sound = scenario.SoundData?.[snippet.ReferenceIndex]
        if (!sound) break
        const fadeMs = effectDurationMs(sound)
        const volume = Number.isFinite(Number(sound.Volume)) ? Number(sound.Volume) : 1
        stats.sounds++
        if (Number(sound.PlayMode) === 4) {
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
        if (sound.Bgm === 'bgm00000') {
          push({ type: 'ChangeBgm', wait, progressBehavior, delay, data: { stop: true, fadeMs } })
        } else if (sound.Bgm) {
          push({
            type: 'ChangeBgm',
            wait,
            progressBehavior,
            delay,
            data: { file: `${sound.Bgm}.mp3`, fadeMs, volume }
          })
        } else if (sound.Se) {
          if (Number(sound.PlayMode) === 3) {
            push({
              type: 'StopSe',
              wait,
              progressBehavior,
              delay,
              data: { file: `${sound.Se}.mp3`, fadeMs }
            })
          } else {
            push({
              type: 'PlaySe',
              wait,
              progressBehavior,
              delay,
              data: {
                file: `${sound.Se}.mp3`,
                volume,
                loop: Number(sound.PlayMode) === 2,
                fadeMs
              }
            })
          }
        }
        break
      }
      case 8: {
        const mode =
          scenario.ScenarioSnippetCharacterLayoutModes?.[snippet.ReferenceIndex]
            ?.CharacterLayoutMode
        stats.layoutModes++
        push({
          type: 'ChangeLayoutMode',
          wait,
          progressBehavior,
          delay,
          data: { mode: layoutModeOf(mode) }
        })
        break
      }
      case 0:
        stats.skippedActions[0] = (stats.skippedActions[0] ?? 0) + 1
        break
      default:
        stats.skippedActions[Number(snippet.Action)] =
          (stats.skippedActions[Number(snippet.Action)] ?? 0) + 1
    }
  }

  return {
    story: {
      models: [...models]
        .sort((a, b) => a - b)
        .map((id) => ({
          id,
          model: `audit/${id}.model3.json`
        })),
      images: [
        { id: 1, image: 'audit/background-1.webp' },
        { id: 2, image: 'audit/background-2.webp' }
      ],
      snippets
    },
    stats
  }
}

function frameFails(fails, episode, index, message) {
  fails.push(`${episode}#${index}: ${message}`)
}

/** 审计一集；返回 { stats, fails }。 */
export function auditEpisode(scenario, episodeId, runtime) {
  const { timeline, plan, timing, text } = runtime
  const { story, stats } = mapOfficialEpisode(scenario)
  const result = timeline.calculateTimeline(story.snippets, new Map())
  const baked = plan.bakeStoryPlan(story.snippets, result.entries)
  const fails = []

  if (result.entries.length !== story.snippets.length) {
    fails.push(
      `${episodeId}: timeline entries ${result.entries.length} != snippets ${story.snippets.length}`
    )
    return { episodeId, stats, fails, summaries: null }
  }
  if (!result.validationSummary.crossValidationPassed) {
    fails.push(`${episodeId}: timeline validation errors ${result.validationSummary.errorCount}`)
  }
  if (result.validationSummary.anomaliesDetected.length > 0) {
    fails.push(`${episodeId}: timeline anomalies ${result.validationSummary.anomaliesDetected[0]}`)
  }

  let talks = 0
  let layouts = 0
  let actions = 0
  let talkWindowOpen = false
  let talkWindowClosesAtFrame = null
  let cursorFrame = timing.PLAYCORE_WARMUP_FRAMES
  let runningFenceEndFrame = 0
  let activeLayoutEndFrame = 0
  let lastEndFrame = 0
  let fstSlots = 0
  let fstDialogOpen = false
  const visibleModels = new Set()
  const lastIndex = story.snippets.length - 1
  for (let i = 0; i < story.snippets.length; i++) {
    const snippet = story.snippets[i]
    const entry = baked.entries[i]
    const timelineEntry = result.entries[i]
    const delayFrames = timing.framesForSeconds(Number(snippet.delay) || 0)
    const blocking = snippet.progressBehavior
      ? snippet.progressBehavior === 'WaitFinished'
      : snippet.wait !== false
    if (entry.blocking !== blocking) {
      frameFails(fails, episodeId, i, `blocking ${entry.blocking} != ${blocking}`)
    }
    if (blocking) {
      cursorFrame = Math.max(cursorFrame, runningFenceEndFrame)
    }
    if (entry.delayStartFrame !== cursorFrame) {
      frameFails(
        fails,
        episodeId,
        i,
        `delayStart ${entry.delayStartFrame} != cursor ${cursorFrame}`
      )
    }
    if (entry.startFrame !== cursorFrame + delayFrames) {
      frameFails(
        fails,
        episodeId,
        i,
        `start ${entry.startFrame} != cursor ${cursorFrame} + delay ${delayFrames}`
      )
    }
    if (talkWindowClosesAtFrame !== null && talkWindowClosesAtFrame <= entry.startFrame) {
      talkWindowOpen = false
      talkWindowClosesAtFrame = null
    }
    // timeline 的 durationMs 已由 framesToMs 量化；再走 f32 秒累加会多一帧。
    // 1ms 是状态片段“同帧完成”的标记，不占故事帧。
    const timelineFrames =
      timelineEntry.durationMs > 0 && timelineEntry.durationMs < timing.FRAME_MS
        ? 0
        : timing.msToFrameCount(timelineEntry.durationMs)
    let expectedWaitFrames = timelineFrames
    if (
      snippet.type !== 'Talk' &&
      snippet.type !== 'FullScreenText' &&
      snippet.type !== 'LayoutAppear' &&
      snippet.type !== 'LayoutClear' &&
      snippet.type !== 'Move' &&
      timing.SECONDS_DURATION_SNIPPET_TYPES.has(snippet.type)
    ) {
      const rawDuration = typeof snippet.data?.duration === 'number' ? snippet.data.duration : 0
      const durationMs = timing.normalizeEffectDurationMs(rawDuration, 0)
      expectedWaitFrames = timing.framesForSeconds(durationMs / 1000)
    }

    const isNotLast = i < lastIndex
    const finishFrame = entry.startFrame + entry.durationFrames
    const expectedEndFrame = finishFrame + (isNotLast ? 1 : 0)
    if (entry.endFrame !== expectedEndFrame) {
      frameFails(
        fails,
        episodeId,
        i,
        `end ${entry.endFrame} != start ${entry.startFrame} + duration ${entry.durationFrames}${isNotLast ? ' + 1' : ''}`
      )
    }
    const taskRan = delayFrames > 0 || entry.durationFrames > 0
    const hasFence = taskRan && isNotLast
    runningFenceEndFrame = Math.max(runningFenceEndFrame, finishFrame + (hasFence ? 1 : 0))
    lastEndFrame = Math.max(lastEndFrame, finishFrame)

    if (snippet.type === 'Talk') {
      talks++
      const expectedWindow = talkWindowOpen ? 0 : timing.TALK_WINDOW_OPEN_CLOSE_FRAMES
      talkWindowOpen = true
      const talk = entry.talk
      if (!talk) {
        frameFails(fails, episodeId, i, 'Talk missing plan')
        continue
      }
      const chars = text.visibleTextLength(snippet.data.content)
      if (talk.windowOpenFrames !== expectedWindow) {
        frameFails(fails, episodeId, i, `window ${talk.windowOpenFrames} != ${expectedWindow}`)
      }
      if (talk.typingEndFrame - talk.typingStartFrame !== chars * timing.WORD_INTERVAL_FRAMES) {
        frameFails(
          fails,
          episodeId,
          i,
          `typing ${talk.typingEndFrame - talk.typingStartFrame} != ${
            chars * timing.WORD_INTERVAL_FRAMES
          } (chars=${chars})`
        )
      }
      if (talk.voiceEndFrame !== null) {
        frameFails(fails, episodeId, i, `voiceEnd ${talk.voiceEndFrame} != null`)
      }
      // 无语音的审计：gate 只等打字结束与仍在跑的布局。
      const expectedGate = Math.max(talk.typingEndFrame, activeLayoutEndFrame)
      if (talk.gateEndFrame !== expectedGate) {
        frameFails(fails, episodeId, i, `gate ${talk.gateEndFrame} != ${expectedGate}`)
      }
      if (talk.computedEndFrame !== expectedGate + timing.AUTO_NEXT_PAGE_DELAY_FRAMES) {
        frameFails(
          fails,
          episodeId,
          i,
          `computedEnd ${talk.computedEndFrame} != gate+${timing.AUTO_NEXT_PAGE_DELAY_FRAMES}`
        )
      }
      if (entry.durationFrames !== talk.computedEndFrame - entry.startFrame) {
        frameFails(
          fails,
          episodeId,
          i,
          `Talk duration ${entry.durationFrames} != ${talk.computedEndFrame - entry.startFrame}`
        )
      }
      if (snippet.data?.closeWindowOnFinish === true) {
        talkWindowClosesAtFrame = talk.computedEndFrame + timing.TALK_WINDOW_OPEN_CLOSE_FRAMES
      }
      for (const action of entry.actions) {
        actions++
        if (action.at !== 0 || action.frame !== entry.startFrame) {
          frameFails(
            fails,
            episodeId,
            i,
            `Talk action at=${action.at} frame=${action.frame} != ${entry.startFrame}`
          )
        }
      }
      continue
    }

    if (snippet.type === 'HideTalk') {
      talkWindowOpen = false
      talkWindowClosesAtFrame = null
    }

    if (snippet.type === 'FullScreenText') {
      const fst = entry.fst
      if (!fst) {
        frameFails(fails, episodeId, i, 'FullScreenText missing plan')
        continue
      }
      const nextType = isNotLast ? story.snippets[i + 1].type : ''
      const first = !fstDialogOpen
      const last = nextType !== 'FullScreenText' && snippet.data?.keepBars !== true
      if (first) fstSlots = 0
      fstDialogOpen = !last
      const slots = timing.fullScreenTextSlots(fstSlots, String(snippet.data?.text ?? ''))
      fstSlots = slots
      const expectedFst = timing.fullScreenTextFrames({ first, last, slots })
      const expectedFstDur =
        expectedFst.textEndFrame + expectedFst.holdFrames + expectedFst.fadeFrames
      if (entry.durationFrames !== expectedFstDur) {
        frameFails(
          fails,
          episodeId,
          i,
          `FullScreenText duration ${entry.durationFrames} != ${expectedFstDur}`
        )
      }
      continue
    }

    if (
      snippet.type === 'LayoutAppear' ||
      snippet.type === 'LayoutClear' ||
      snippet.type === 'Move'
    ) {
      layouts++
      const layout = entry.layout
      if (!layout) {
        frameFails(fails, episodeId, i, `${snippet.type} missing plan`)
        continue
      }
      const moveFrames = timing.msToFrameCount(
        timing.MOVE_SPEED_DURATION_MS[snippet.data.moveSpeed]
      )
      const moved =
        snippet.data.from.side !== snippet.data.to.side ||
        (Number(snippet.data.from.offset) || 0) !== (Number(snippet.data.to.offset) || 0) ||
        Boolean(snippet.data.from.under) !== Boolean(snippet.data.to.under)
      const modelId = snippet.data.modelId
      const wasVisible = visibleModels.has(modelId)
      if (snippet.type === 'LayoutAppear') {
        const hasMotion = String(snippet.data.motion ?? '').trim() !== ''
        const forced = !wasVisible && hasMotion ? 1 : 0
        const at = entry.startFrame + forced
        const expectedMove = wasVisible ? timing.APPEAR_SHOWN_MOVE_FRAMES : moveFrames
        const expectedAppearFrames = moved
          ? timing.APPEAR_FADE_TOTAL_FRAMES
          : timing.APPEAR_IN_PLACE_FADE_TOTAL_FRAMES
        if (wasVisible) {
          if (layout.fadeStartFrame !== null || layout.fadeEndFrame !== null) {
            frameFails(fails, episodeId, i, 'shown appear must not fade')
          }
        } else {
          if (layout.fadeStartFrame !== at + 1) {
            frameFails(fails, episodeId, i, `appear fadeStart ${layout.fadeStartFrame}`)
          }
          if (layout.fadeEndFrame !== at + expectedAppearFrames) {
            frameFails(fails, episodeId, i, `appear fadeEnd ${layout.fadeEndFrame}`)
          }
        }
        const expectedMoveEnd = wasVisible ? entry.startFrame + expectedMove : at + expectedMove
        if (layout.moveEndFrame !== expectedMoveEnd) {
          frameFails(fails, episodeId, i, `appear moveEnd ${layout.moveEndFrame}`)
        }
        const expectedDuration = wasVisible
          ? timing.APPEAR_SHOWN_MOVE_FRAMES
          : expectedAppearFrames + forced
        if (entry.durationFrames !== expectedDuration) {
          frameFails(fails, episodeId, i, `appear duration ${entry.durationFrames}`)
        }
        const activeSlideEnd = wasVisible ? layout.moveEndFrame : at + expectedAppearFrames
        activeLayoutEndFrame = Math.max(activeLayoutEndFrame, activeSlideEnd)
        visibleModels.add(modelId)
      } else if (snippet.type === 'LayoutClear') {
        if (!wasVisible) {
          if (layout.fadeStartFrame !== null || layout.fadeEndFrame !== null) {
            frameFails(fails, episodeId, i, 'hidden clear must not fade')
          }
          if (layout.moveEndFrame !== entry.startFrame) {
            frameFails(fails, episodeId, i, `hidden clear moveEnd ${layout.moveEndFrame}`)
          }
          if (entry.durationFrames !== 0) {
            frameFails(fails, episodeId, i, `hidden clear duration ${entry.durationFrames}`)
          }
          visibleModels.delete(modelId)
          continue
        }
        const fadeFrames = timing.msToFrameCount(timing.CHARACTER_FADE_MS)
        if (moved) {
          if (layout.moveEndFrame !== entry.startFrame + moveFrames) {
            frameFails(fails, episodeId, i, `clear moveEnd ${layout.moveEndFrame}`)
          }
          if (layout.fadeStartFrame !== entry.startFrame + Math.max(0, moveFrames - fadeFrames)) {
            frameFails(fails, episodeId, i, `clear fadeStart ${layout.fadeStartFrame}`)
          }
          if (layout.fadeEndFrame !== entry.startFrame + Math.max(fadeFrames, moveFrames)) {
            frameFails(fails, episodeId, i, `clear fadeEnd ${layout.fadeEndFrame}`)
          }
          if (entry.durationFrames !== Math.max(fadeFrames, moveFrames)) {
            frameFails(fails, episodeId, i, `clear duration ${entry.durationFrames}`)
          }
        } else {
          if (
            layout.fadeStartFrame !==
            entry.startFrame + timing.msToFrameCount(timing.HIDE_DELAY_IN_PLACE_SMOOTH_MS)
          ) {
            frameFails(fails, episodeId, i, `clear in-place fadeStart ${layout.fadeStartFrame}`)
          }
          if (entry.durationFrames !== timing.HIDE_IN_PLACE_SMOOTH_TOTAL_FRAMES) {
            frameFails(fails, episodeId, i, `clear in-place duration ${entry.durationFrames}`)
          }
        }
        activeLayoutEndFrame = Math.max(
          activeLayoutEndFrame,
          layout.fadeEndFrame ?? entry.startFrame
        )
        visibleModels.delete(modelId)
      } else {
        if (layout.moveEndFrame !== entry.startFrame + moveFrames) {
          frameFails(fails, episodeId, i, `move end ${layout.moveEndFrame}`)
        }
        if (entry.durationFrames !== moveFrames) {
          frameFails(fails, episodeId, i, `move duration ${entry.durationFrames}`)
        }
        activeLayoutEndFrame = Math.max(activeLayoutEndFrame, layout.moveEndFrame)
      }
      continue
    }

    if (entry.durationFrames !== expectedWaitFrames) {
      frameFails(
        fails,
        episodeId,
        i,
        `duration ${entry.durationFrames} != expected ${expectedWaitFrames}`
      )
    }
  }

  // 非阻塞片段不推进 cursor，但它的 delay/动画仍可能成为最后一个 end；
  // 成片尾固定补 playedWaitTime + 1 + BGM 淡出 31 帧。
  const totalFrames = timing.storyEndFrame(lastEndFrame)
  if (baked.totalFrames !== totalFrames) {
    fails.push(`${episodeId}: plan total ${baked.totalFrames} != replay end ${totalFrames}`)
  }
  const subFrameCues = result.entries.filter(
    (entry) => entry.durationMs > 0 && entry.durationMs < timing.FRAME_MS
  ).length
  const tolerance = 17 + subFrameCues * timing.FRAME_MS
  if (Math.abs(timing.framesToMs(totalFrames) - baked.totalMs) > tolerance) {
    fails.push(`${episodeId}: plan totalMs ${Math.round(baked.totalMs)} != frame end`)
  }

  return {
    episodeId,
    stats,
    fails,
    summaries: {
      snippets: story.snippets.length,
      talks,
      layouts,
      actions,
      totalFrames: baked.totalFrames,
      totalMs: Math.round(baked.totalMs)
    }
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 读取日服 index.json；返回可审计的 episode 列表。 */
export function listCorpusEpisodes(corpusRoot = DEFAULT_CORPUS) {
  const indexPath = path.join(corpusRoot, 'index.json')
  const index = readJson(indexPath)
  return (index.episodes ?? [])
    .filter((episode) => episode.region === 'jp' && episode.ok !== false)
    .map((episode) => ({
      id: episode.scenarioId ?? path.basename(episode.path, '.json'),
      path: episode.path,
      title: episode.title ?? ''
    }))
}

export function auditCorpus(corpusRoot = DEFAULT_CORPUS, options = {}) {
  const runtime = options.runtime ?? loadAuditRuntime()
  const episodes = listCorpusEpisodes(corpusRoot)
  const limit = Number(options.limit) || 0
  const selected = limit > 0 ? episodes.slice(0, limit) : episodes
  const failures = []
  const totals = {
    episodes: 0,
    snippets: 0,
    talks: 0,
    motions: 0,
    appears: 0,
    clears: 0,
    moves: 0,
    effects: 0,
    sounds: 0,
    layoutModes: 0,
    actions: 0,
    nonWait: 0,
    skippedEffects: {},
    skippedActions: {}
  }
  const episodeSummaries = []

  for (const episode of selected) {
    let scenario
    try {
      scenario = readJson(episode.path)
    } catch (error) {
      failures.push(`${episode.id}: cannot read scenario: ${error.message}`)
      continue
    }
    const result = auditEpisode(scenario, episode.id, runtime)
    totals.episodes++
    if (result.summaries) {
      totals.snippets += result.summaries.snippets
      totals.actions += result.summaries.actions
    }
    for (const key of [
      'talks',
      'motions',
      'appears',
      'clears',
      'moves',
      'effects',
      'sounds',
      'layoutModes',
      'nonWait'
    ]) {
      totals[key] += result.stats[key] ?? 0
    }
    for (const [type, count] of Object.entries(result.stats.skippedEffects)) {
      totals.skippedEffects[type] = (totals.skippedEffects[type] ?? 0) + count
    }
    for (const [type, count] of Object.entries(result.stats.skippedActions)) {
      totals.skippedActions[type] = (totals.skippedActions[type] ?? 0) + count
    }
    failures.push(...result.fails)
    episodeSummaries.push({
      id: episode.id,
      title: episode.title,
      ...result.summaries,
      failures: result.fails.length
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    corpusRoot,
    episodes: totals.episodes,
    totals,
    failures,
    episodeSummaries
  }
}

function parseArgs(argv) {
  const out = { corpus: DEFAULT_CORPUS, out: DEFAULT_OUT, limit: 0 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--corpus') out.corpus = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--limit') out.limit = Number(next())
    else throw new Error(`unknown option: ${arg}`)
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const report = auditCorpus(args.corpus, { limit: args.limit })
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify(
      {
        episodes: report.episodes,
        totals: report.totals,
        failures: report.failures.length,
        firstFailure: report.failures[0] ?? null,
        out: args.out
      },
      null,
      2
    )
  )
  if (report.failures.length > 0) process.exitCode = 1
}
