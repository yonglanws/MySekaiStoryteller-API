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
 *     --corpus D:/Users/桌面/mzkbot/msst-ai-lab/corpus \
 *     --out D:/Users/桌面/mzkbot/msst-ai-lab/official-plan-audit.json
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { layoutModeOf, sideFadeOf, sideOf, speedOf } from './pjsk-scenario.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

const DEFAULT_CORPUS = 'D:/Users/桌面/mzkbot/msst-ai-lab/corpus'
const DEFAULT_OUT = 'D:/Users/桌面/mzkbot/msst-ai-lab/official-plan-audit.json'

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
    delay: 0,
    data: { mode: layoutModeOf(scenario.FirstCharacterLayoutMode) }
  })
  push({
    type: 'ChangeBackgroundImage',
    wait: false,
    delay: 0,
    data: { imageId: 1 }
  })
  if (scenario.FirstBgm && scenario.FirstBgm !== 'bgm00000') {
    push({
      type: 'ChangeBgm',
      wait: false,
      delay: 0,
      data: { file: `${scenario.FirstBgm}.mp3`, fadeMs: 600 }
    })
  }

  for (const snippet of scenario.Snippets ?? []) {
    const wait = Number(snippet.ProgressBehavior) === 1
    const delay = Number(snippet.Delay) || 0
    switch (Number(snippet.Action)) {
      case 1: {
        const talk = scenario.TalkData?.[snippet.ReferenceIndex]
        if (!talk) break
        const modelId = modelIdOf(talk.TalkCharacters?.[0]?.Character2dId)
        const actions = addActions(talk.Motions ?? [])
        stats.talks++
        push({
          type: 'Talk',
          wait,
          delay,
          data: {
            speaker: talk.WindowDisplayName ?? '',
            content: talk.Body ?? '',
            ttsText: '',
            voice: '',
            modelId,
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
        if (Number(snippet.Action) === 4 || Number(layout.Type) === 0) {
          if (!layout.MotionName && !layout.FacialName) break
          // 官方 ChangeMotion 不等剪辑；0.1s actions 序列只发 cue。
          stats.motions++
          push({
            type: 'Motion',
            wait,
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
        if (Number(layout.Type) === 2) {
          stats.appears++
          push({
            type: 'LayoutAppear',
            wait,
            delay,
            data: {
              ...base,
              motion: layout.MotionName || '',
              facial: layout.FacialName || ''
            }
          })
        } else if (Number(layout.Type) === 3) {
          stats.clears++
          push({
            type: 'LayoutClear',
            wait,
            delay,
            data: {
              ...base,
              motion: layout.MotionName || '',
              facial: layout.FacialName || ''
            }
          })
        } else if (Number(layout.Type) === 1) {
          stats.moves++
          push({
            type: 'Move',
            wait,
            delay,
            data: {
              ...base,
              motion: layout.MotionName || '',
              facial: layout.FacialName || ''
            }
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
          case 1:
            push({ type: 'BlackIn', wait, delay, data: { duration: durationMs, color: 'black' } })
            break
          case 2:
            push({ type: 'HideTalk', wait: true, delay: 0, data: {} })
            push({
              type: 'BlackOut',
              wait,
              delay,
              data: { duration: durationMs, color: 'black' }
            })
            break
          case 3:
            push({ type: 'BlackIn', wait, delay, data: { duration: durationMs, color: 'white' } })
            break
          case 4:
            push({ type: 'HideTalk', wait: true, delay: 0, data: {} })
            push({
              type: 'BlackOut',
              wait,
              delay,
              data: { duration: durationMs, color: 'white' }
            })
            break
          case 5:
          case 6:
            push({
              type: 'ShakeScreen',
              wait,
              delay,
              data: { duration: Math.max(1, durationMs) }
            })
            break
          case 7:
            push({ type: 'ChangeBackgroundImage', wait, delay, data: { imageId: 2 } })
            break
          case 8:
          case 18:
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
          case 13:
          case 14:
            push({
              type: 'AmbientColor',
              wait,
              delay,
              data: {
                mode: type === 12 ? 'normal' : type === 13 ? 'evening' : 'night'
              }
            })
            break
          case 20:
          case 21:
          case 40:
          case 41:
            push({
              type: 'Wipe',
              wait,
              delay,
              data: {
                mode: type % 2 === 0 ? 'in' : 'out',
                direction: 'right',
                duration: durationMs
              }
            })
            break
          case 25:
          case 26:
            push({ type: 'StopShake', wait, delay, data: {} })
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
              delay,
              data: { ...fade, duration: durationMs }
            })
            break
          }
          case 38:
          case 39:
            push({
              type: 'BackgroundBlur',
              wait,
              delay,
              data: { enabled: type === 38 }
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
            push({ type: 'CameraMove', wait, delay, data: { x, y, duration: durationMs } })
            break
          }
          case 43:
            push({
              type: 'CameraZoom',
              wait,
              delay,
              data: {
                scale: Number.parseFloat(effect.StringVal) || 1,
                duration: durationMs
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
        stats.sounds++
        if (Number(sound.PlayMode) === 4) break
        if (sound.Bgm === 'bgm00000') {
          push({ type: 'ChangeBgm', wait, delay, data: { stop: true, fadeMs } })
        } else if (sound.Bgm) {
          push({
            type: 'ChangeBgm',
            wait,
            delay,
            data: { file: `${sound.Bgm}.mp3`, fadeMs, volume: Number(sound.Volume) || 1 }
          })
        } else if (sound.Se) {
          if (Number(sound.PlayMode) === 3) {
            push({ type: 'StopSe', wait, delay, data: { file: `${sound.Se}.mp3`, fadeMs } })
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
      case 8: {
        const mode =
          scenario.ScenarioSnippetCharacterLayoutModes?.[snippet.ReferenceIndex]
            ?.CharacterLayoutMode
        stats.layoutModes++
        push({ type: 'ChangeLayoutMode', wait, delay, data: { mode: layoutModeOf(mode) } })
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
  let windowOpen = false
  let cursorFrame = 0
  let lastEndFrame = 0
  const visibleModels = new Set()
  for (let i = 0; i < story.snippets.length; i++) {
    const snippet = story.snippets[i]
    const entry = baked.entries[i]
    const timelineEntry = result.entries[i]
    const delayFrames = timing.framesForSeconds(Number(snippet.delay) || 0)
    const blocking = snippet.wait !== false || snippet.type === 'Talk'
    if (entry.blocking !== blocking) {
      frameFails(fails, episodeId, i, `blocking ${entry.blocking} != ${blocking}`)
    }
    if (entry.startFrame !== cursorFrame + delayFrames) {
      frameFails(
        fails,
        episodeId,
        i,
        `start ${entry.startFrame} != cursor ${cursorFrame} + delay ${delayFrames}`
      )
    }
    if (entry.durationFrames !== timing.framesForSeconds(timelineEntry.durationMs / 1000)) {
      frameFails(
        fails,
        episodeId,
        i,
        `duration ${entry.durationFrames} != timeline ${timing.framesForSeconds(
          timelineEntry.durationMs / 1000
        )}`
      )
    }
    if (entry.endFrame !== entry.startFrame + entry.durationFrames) {
      frameFails(
        fails,
        episodeId,
        i,
        `end ${entry.endFrame} != start ${entry.startFrame} + duration ${entry.durationFrames}`
      )
    }
    if (blocking) cursorFrame = entry.endFrame
    lastEndFrame = Math.max(lastEndFrame, entry.endFrame)

    if (snippet.type === 'Talk') {
      talks++
      const expectedWindow = windowOpen ? 0 : timing.msToFrames(timing.TALK_WINDOW_OPEN_CLOSE_MS)
      windowOpen = true
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
      if (talk.gateEndFrame !== talk.typingEndFrame) {
        frameFails(
          fails,
          episodeId,
          i,
          `gate ${talk.gateEndFrame} != typing ${talk.typingEndFrame}`
        )
      }
      if (talk.computedEndFrame !== talk.typingEndFrame + timing.AUTO_NEXT_PAGE_DELAY_FRAMES) {
        frameFails(fails, episodeId, i, `computedEnd ${talk.computedEndFrame} != typing+120`)
      }
      if (entry.durationFrames !== talk.computedEndFrame - entry.startFrame) {
        frameFails(
          fails,
          episodeId,
          i,
          `Talk duration ${entry.durationFrames} != ${talk.computedEndFrame - entry.startFrame}`
        )
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
      windowOpen = false
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
      const moveFrames = timing.framesForSeconds(
        timing.MOVE_SPEED_DURATION_MS[snippet.data.moveSpeed] / 1000
      )
      const moved =
        snippet.data.from.side !== snippet.data.to.side ||
        (Number(snippet.data.from.offset) || 0) !== (Number(snippet.data.to.offset) || 0)
      const modelId = snippet.data.modelId
      const wasVisible = visibleModels.has(modelId)
      if (snippet.type === 'LayoutAppear') {
        const expectedMove = wasVisible ? timing.APPEAR_SHOWN_MOVE_FRAMES : moveFrames
        if (wasVisible) {
          if (layout.fadeStartFrame !== null || layout.fadeEndFrame !== null) {
            frameFails(fails, episodeId, i, 'shown appear must not fade')
          }
        } else {
          if (layout.fadeStartFrame !== entry.startFrame + 1) {
            frameFails(fails, episodeId, i, `appear fadeStart ${layout.fadeStartFrame}`)
          }
          if (layout.fadeEndFrame !== entry.startFrame + timing.APPEAR_FADE_TOTAL_FRAMES) {
            frameFails(fails, episodeId, i, `appear fadeEnd ${layout.fadeEndFrame}`)
          }
        }
        if (layout.moveEndFrame !== entry.startFrame + expectedMove) {
          frameFails(fails, episodeId, i, `appear moveEnd ${layout.moveEndFrame}`)
        }
        const expectedDuration = wasVisible
          ? timing.APPEAR_SHOWN_MOVE_FRAMES
          : timing.APPEAR_FADE_TOTAL_FRAMES
        if (entry.durationFrames !== (blocking ? expectedDuration : 0)) {
          frameFails(fails, episodeId, i, `appear duration ${entry.durationFrames}`)
        }
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
        const fadeFrames = timing.framesForSeconds(timing.CHARACTER_FADE_MS / 1000)
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
          if (entry.durationFrames !== (blocking ? Math.max(fadeFrames, moveFrames) : 0)) {
            frameFails(fails, episodeId, i, `clear duration ${entry.durationFrames}`)
          }
        } else {
          if (
            layout.fadeStartFrame !==
            entry.startFrame + timing.framesForSeconds(timing.HIDE_DELAY_IN_PLACE_MS / 1000)
          ) {
            frameFails(fails, episodeId, i, `clear in-place fadeStart ${layout.fadeStartFrame}`)
          }
          if (entry.durationFrames !== (blocking ? timing.HIDE_IN_PLACE_TOTAL_FRAMES : 0)) {
            frameFails(fails, episodeId, i, `clear in-place duration ${entry.durationFrames}`)
          }
        }
        visibleModels.delete(modelId)
      } else {
        if (layout.moveEndFrame !== entry.startFrame + moveFrames) {
          frameFails(fails, episodeId, i, `move end ${layout.moveEndFrame}`)
        }
        if (entry.durationFrames !== (blocking ? moveFrames : 0)) {
          frameFails(fails, episodeId, i, `move duration ${entry.durationFrames}`)
        }
      }
    }
  }

  // 非阻塞片段不推进 cursor，但它的 delay/动画仍可能成为最后一个 end。
  if (baked.totalFrames !== lastEndFrame) {
    fails.push(`${episodeId}: plan total ${baked.totalFrames} != replay end ${lastEndFrame}`)
  }
  const subFrameCues = result.entries.filter(
    (entry) => entry.durationMs > 0 && entry.durationMs < timing.FRAME_MS
  ).length
  const tolerance = 17 + subFrameCues * timing.FRAME_MS
  if (Math.abs(timing.framesToMs(lastEndFrame) - baked.totalMs) > tolerance) {
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
