/**
 * 剧本量化指标：官方 scenario JSON 与宿主 StoryData 共用。
 *
 * 目的：把“像不像官方剧本”拆成可测的数字——台词长度、连续说话、动作密度、
 * 听者反应、情绪切换频率、走位/背景/SE/转场次数——便于提示词迭代前后对比。
 *
 * 只读，不依赖宿主编译产物。
 */

export const EMOTION_LABELS = ['平静', '开心', '生气', '伤心', '害羞', '惊讶']

/** 官方表情名 → 6 个 TTS 情绪标签的粗映射；拿不准的一律算平静，避免虚假的“情绪丰富”。 */
export function emotionOfFacial(name) {
  const value = String(name || '').toLowerCase()
  if (!value) return ''
  if (/cry|sad|tear|worry/.test(value)) return '伤心'
  if (/angry|disgust|sharp|pout/.test(value)) return '生气'
  if (/shy|blush|embarrass/.test(value)) return '害羞'
  if (/surprise|shock|notice|baffl|surprised/.test(value)) return '惊讶'
  if (/smile|happy|sparkl|twinkle|smug|doya|fun|joy|laugh/.test(value)) return '开心'
  return '平静'
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/
const countChars = (text) =>
  Array.from(String(text || '').replace(/\s/g, '')).filter((char) => !/[\u0000-\u001f]/.test(char))
    .length

/** 粗略成片时长：中文约 5 字/秒，加上每句换气与动作停顿。 */
export const estimateSeconds = (lines) =>
  lines.reduce((sum, line) => sum + countChars(line.body) / 5.2 + 0.85, 0)

export const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

export const percentile = (values, p) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[index]
}

const share = (values, predicate) =>
  values.length ? values.filter(predicate).length / values.length : 0

function runLengths(items, key = (item) => item) {
  const runs = []
  for (const item of items) {
    const value = key(item)
    const last = runs[runs.length - 1]
    if (last && last.value === value) last.count += 1
    else runs.push({ value, count: 1 })
  }
  return runs
}

/** 只保留正式台词（Action 0/1/8）；Action 8 是特殊说话（心声/耳语等）。 */
const TALK_ACTIONS = new Set([0, 1, 8])

/**
 * 官方 scenario → 统一行记录。
 * @param {object} jp 日服 scenario（结构、动作、表情）
 * @param {object|null} translated 中文 scenario（台词文本；长度不一致时退回日文）
 */
export function officialToLines(jp, translated = null) {
  const talkData = Array.isArray(jp.TalkData) ? jp.TalkData : []
  const translatedTalks =
    translated &&
    Array.isArray(translated.TalkData) &&
    translated.TalkData.length === talkData.length
      ? translated.TalkData
      : null

  // AppearCharacters 是本集用到的全部立绘（含换装），不是开场在场角色；
  // 真正的上下场由 LayoutData Type 2/3 决定，必须从空舞台开始模拟。
  const stage = new Set()
  let background = String(jp.FirstBackground || '')
  let bgm = String(jp.FirstBgm || '')
  let ambient = 'normal'
  const pending = { se: [], effects: [], layout: [], motions: [], bg: 0, bgm: 0, ambient: 0 }

  const lines = []
  for (const snippet of jp.Snippets || []) {
    const action = Number(snippet.Action)
    const ref = Number(snippet.ReferenceIndex) || 0
    if (action === 2 || action === 4) {
      const layout = jp.LayoutData?.[ref]
      if (!layout) continue
      const modelId = Number(layout.Character2dId)
      // Action 4 / Type 0 是独立的动作节拍，不改变站位；它可能属于说话者，也可能是听者反应。
      if (action === 4 || Number(layout.Type) === 0 || Number(layout.Type) === 6) {
        if (layout.MotionName || layout.FacialName) {
          pending.motions.push({
            modelId,
            motion: String(layout.MotionName || ''),
            facial: String(layout.FacialName || '')
          })
        }
        if (action === 4) continue
      }
      if (action === 2 && Number(layout.Type) === 2) {
        stage.add(modelId)
        pending.layout.push({ kind: 'appear', modelId })
      } else if (action === 2 && Number(layout.Type) === 3) {
        stage.delete(modelId)
        pending.layout.push({ kind: 'clear', modelId })
      } else if (action === 2 && (Number(layout.Type) === 1 || Number(layout.Type) === 6)) {
        pending.layout.push({ kind: 'move', modelId })
      }
      continue
    }
    if (action === 6) {
      const effect = jp.SpecialEffectData?.[ref]
      if (!effect) continue
      const type = Number(effect.EffectType)
      if (type === 7) {
        background = String(effect.StringValSub || effect.StringVal || background)
        pending.bg += 1
      }
      if (type === 12) {
        ambient = 'normal'
        pending.ambient += 1
      }
      if (type === 13) {
        ambient = 'evening'
        pending.ambient += 1
      }
      if (type === 14) {
        ambient = 'night'
        pending.ambient += 1
      }
      pending.effects.push(type)
      continue
    }
    if (action === 7) {
      const sound = jp.SoundData?.[ref]
      if (!sound) continue
      if (sound.Bgm) {
        bgm = String(sound.Bgm)
        if (bgm && bgm !== 'bgm00000') pending.bgm += 1
      } else if (sound.Se) {
        pending.se.push(String(sound.Se))
      }
      continue
    }
    if (!TALK_ACTIONS.has(action)) continue

    const talk = talkData[ref]
    if (!talk) continue
    const speakerId = Number(talk.TalkCharacters?.[0]?.Character2dId)
    const sourceBody = String(talk.Body || '')
    const translatedBody = translatedTalks?.[ref]?.Body
    const body =
      translatedBody && CJK.test(translatedBody) && !/[\u3040-\u30ff]/.test(translatedBody)
        ? String(translatedBody)
        : sourceBody

    const actions = (talk.Motions || [])
      .map((motion) => ({
        modelId: Number(motion.Character2dId),
        motion: String(motion.MotionName || ''),
        facial: String(motion.FacialName || '')
      }))
      .filter((motion) => motion.motion || motion.facial)

    const speakerActions = actions.filter((motion) => motion.modelId === speakerId)
    const listenerActions = actions.filter((motion) => motion.modelId !== speakerId)
    const facial = speakerActions.find((motion) => motion.facial)?.facial ?? ''

    lines.push({
      index: lines.length,
      speakerId,
      speaker: String(talk.WindowDisplayName || speakerId),
      body,
      chars: countChars(body),
      emotion: emotionOfFacial(facial),
      facial,
      speakerActions,
      listenerActions,
      preMotions: pending.motions.splice(0),
      stageIds: [...stage],
      background,
      ambient,
      bgm,
      se: pending.se.splice(0),
      effects: pending.effects.splice(0),
      layout: pending.layout.splice(0),
      bgChanges: pending.bg,
      bgmChanges: pending.bgm,
      ambientChanges: pending.ambient
    })
    pending.bg = 0
    pending.bgm = 0
    pending.ambient = 0
  }
  return lines
}

/**
 * 宿主 StoryData（*.sekai-story.json 或 /script/generate 的 story）→ 统一行记录。
 * 只认渲染器实际支持的片段。
 */
export function storyToLines(story) {
  const snippets = Array.isArray(story?.snippets) ? story.snippets : []
  const modelNames = new Map()
  for (const model of story?.models || []) {
    modelNames.set(Number(model.id), String(model.name || model.shortName || model.id))
  }
  const imageNames = new Map()
  for (const image of story?.images || []) {
    imageNames.set(Number(image.id), String(image.image || image.id))
  }

  const stage = new Set()
  let background = ''
  let ambient = 'normal'
  let bgm = ''
  const pending = { se: [], effects: [], layout: [], bg: 0, bgm: 0, ambient: 0 }
  const lines = []

  for (const snippet of snippets) {
    const data = snippet?.data || {}
    switch (snippet?.type) {
      case 'LayoutAppear': {
        const modelId = Number(data.modelId)
        stage.add(modelId)
        pending.layout.push({ kind: 'appear', modelId })
        break
      }
      case 'LayoutClear': {
        const modelId = Number(data.modelId)
        stage.delete(modelId)
        pending.layout.push({ kind: 'clear', modelId })
        break
      }
      case 'Move': {
        pending.layout.push({ kind: 'move', modelId: Number(data.modelId) })
        break
      }
      case 'ChangeBackgroundImage': {
        background = imageNames.get(Number(data.imageId)) ?? background
        pending.bg += 1
        break
      }
      case 'AmbientColor': {
        ambient = String(data.mode || 'normal')
        pending.ambient += 1
        break
      }
      case 'ChangeBgm': {
        if (data.stop || !data.file) {
          bgm = ''
        } else {
          bgm = String(data.file)
          pending.bgm += 1
        }
        break
      }
      case 'PlaySe': {
        pending.se.push(String(data.file || ''))
        break
      }
      case 'ShakeScreen':
      case 'FlashbackIn':
      case 'FlashbackOut':
      case 'Wipe':
      case 'CameraMove':
      case 'CameraZoom':
        pending.effects.push(snippet.type)
        break
      case 'Talk': {
        const speakerId = Number(data.modelId)
        const body = String(data.content || '')
        const actions = Array.isArray(data.actions)
          ? data.actions
              .map((action) => ({
                modelId: Number(action.modelId),
                motion: String(action.motion || ''),
                facial: String(action.facial || '')
              }))
              .filter((action) => action.motion || action.facial)
          : []
        const speakerActions = actions.filter((action) => action.modelId === speakerId)
        const listenerActions = actions.filter((action) => action.modelId !== speakerId)
        lines.push({
          index: lines.length,
          speakerId,
          speaker: String(data.speaker || speakerId),
          body,
          chars: countChars(body),
          emotion: String(data.emotion || ''),
          facial: speakerActions.find((action) => action.facial)?.facial ?? '',
          speakerActions,
          listenerActions,
          preMotions: [],
          stageIds: [...stage],
          background,
          ambient,
          bgm,
          se: pending.se.splice(0),
          effects: pending.effects.splice(0),
          layout: pending.layout.splice(0),
          bgChanges: pending.bg,
          bgmChanges: pending.bgm,
          ambientChanges: pending.ambient
        })
        pending.bg = 0
        pending.bgm = 0
        pending.ambient = 0
        break
      }
      default:
        break
    }
  }
  return lines
}

/** 把行序列切成固定长度窗口（默认 40 句 ≈ 3 分钟），用于与 AI 生成的短戏对齐比较。 */
export function windowsOf(lines, size = 40) {
  const windows = []
  for (let start = 0; start + size <= lines.length; start += size) {
    windows.push(lines.slice(start, start + size))
  }
  return windows
}

export function summarize(lines) {
  const chars = lines.map((line) => line.chars)
  const speakerActions = lines.map((line) => line.speakerActions.length)
  const listenerActions = lines.map((line) => line.listenerActions.length)
  const emotions = lines.map((line) => line.emotion).filter(Boolean)
  const emotionChanges = emotions
    .slice(1)
    .map((emotion, index) => (emotion !== emotions[index] ? 1 : 0))
    .reduce((sum, value) => sum + value, 0)
  const speakerRuns = runLengths(lines, (line) => line.speaker)
  const emotionRuns = runLengths(
    lines.map((line) => line.emotion).filter(Boolean),
    (emotion) => emotion
  )

  const bySpeaker = new Map()
  for (const line of lines) {
    if (!bySpeaker.has(line.speakerId)) bySpeaker.set(line.speakerId, [])
    bySpeaker.get(line.speakerId).push(line)
  }
  const speakerEmotionChanges = []
  const speakerFacialChanges = []
  for (const speakerLines of bySpeaker.values()) {
    for (let index = 1; index < speakerLines.length; index++) {
      if (speakerLines[index].emotion !== speakerLines[index - 1].emotion) {
        speakerEmotionChanges.push(1)
      }
      if (speakerLines[index].facial !== speakerLines[index - 1].facial) {
        speakerFacialChanges.push(1)
      }
    }
  }

  const distribution = Object.fromEntries(EMOTION_LABELS.map((label) => [label, 0]))
  for (const emotion of emotions) distribution[emotion] = (distribution[emotion] ?? 0) + 1

  const countEvents = (key) =>
    lines.reduce(
      (sum, line) => sum + (Array.isArray(line[key]) ? line[key].length : Number(line[key]) || 0),
      0
    )
  const countLayout = (kind) =>
    lines.reduce((sum, line) => sum + line.layout.filter((event) => event.kind === kind).length, 0)
  const effectCount = (name) =>
    lines.reduce((sum, line) => sum + line.effects.filter((effect) => effect === name).length, 0)
  const motionBeats = lines.reduce((sum, line) => sum + (line.preMotions?.length || 0), 0)
  const listenerReactionLines = lines.filter(
    (line) => line.listenerActions.length > 0 || (line.preMotions?.length || 0) > 0
  ).length

  return {
    lines: lines.length,
    estimatedSeconds: Math.round(estimateSeconds(lines)),
    text: {
      charsTotal: chars.reduce((sum, value) => sum + value, 0),
      charsMean: Number(mean(chars).toFixed(2)),
      charsP50: percentile(chars, 0.5),
      charsP90: percentile(chars, 0.9),
      shortShare: Number(share(chars, (value) => value > 0 && value <= 6).toFixed(3)),
      longShare: Number(share(chars, (value) => value > 26).toFixed(3)),
      newlineShare: Number(share(lines, (line) => String(line.body).includes('\n')).toFixed(3)),
      questionShare: Number(share(lines, (line) => /[?？]/.test(line.body)).toFixed(3)),
      exclaimShare: Number(share(lines, (line) => /[!！]/.test(line.body)).toFixed(3)),
      ellipsisShare: Number(share(lines, (line) => /…|\.\.\./.test(line.body)).toFixed(3))
    },
    turns: {
      speakerRuns: speakerRuns.length,
      speakerRunMean: Number(mean(speakerRuns.map((run) => run.count)).toFixed(2)),
      speakerRunMax: Math.max(0, ...speakerRuns.map((run) => run.count)),
      soloRunShare: Number(share(speakerRuns, (run) => run.count === 1).toFixed(3)),
      longRunShare: Number(share(speakerRuns, (run) => run.count >= 4).toFixed(3)),
      speakers: bySpeaker.size
    },
    acting: {
      speakerActionsMean: Number(mean(speakerActions).toFixed(2)),
      noActionShare: Number(share(speakerActions, (value) => value === 0).toFixed(3)),
      oneActionShare: Number(share(speakerActions, (value) => value === 1).toFixed(3)),
      multiActionShare: Number(share(speakerActions, (value) => value >= 2).toFixed(3)),
      listenerShare: Number((listenerReactionLines / Math.max(1, lines.length)).toFixed(3)),
      inlineListenerShare: Number(share(listenerActions, (value) => value > 0).toFixed(3)),
      preMotionPer40: Number(((motionBeats / Math.max(1, lines.length)) * 40).toFixed(2)),
      listenerMean: Number(mean(listenerActions).toFixed(2))
    },
    emotion: {
      distribution,
      strongShare: Number(share(emotions, (emotion) => emotion && emotion !== '平静').toFixed(3)),
      changesPer40: Number(((emotionChanges / Math.max(1, emotions.length)) * 40).toFixed(2)),
      adjacentChangeShare: Number((emotionChanges / Math.max(1, emotions.length - 1)).toFixed(3)),
      runMean: Number(mean(emotionRuns.map((run) => run.count)).toFixed(2)),
      speakerAdjacentChangeShare: Number(
        (
          speakerEmotionChanges.length /
          Math.max(1, speakerEmotionChanges.length + speakerFacialChanges.length)
        ).toFixed(3)
      )
    },
    stage: {
      stageMean: Number(mean(lines.map((line) => line.stageIds.length)).toFixed(2)),
      soloShare: Number(share(lines, (line) => line.stageIds.length <= 1).toFixed(3)),
      trioShare: Number(share(lines, (line) => line.stageIds.length >= 3).toFixed(3)),
      backgrounds: new Set(lines.map((line) => line.background)).size,
      bgChangesPer40: Number(((countEvents('bgChanges') / lines.length) * 40).toFixed(2)),
      appearsPer40: Number(((countLayout('appear') / lines.length) * 40).toFixed(2)),
      clearsPer40: Number(((countLayout('clear') / lines.length) * 40).toFixed(2)),
      movesPer40: Number(((countLayout('move') / lines.length) * 40).toFixed(2)),
      sePer40: Number(((countEvents('se') / lines.length) * 40).toFixed(2)),
      bgmChangesPer40: Number(((countEvents('bgmChanges') / lines.length) * 40).toFixed(2)),
      ambientPer40: Number(((countEvents('ambientChanges') / lines.length) * 40).toFixed(2)),
      shakePer40: Number(((effectCount('ShakeScreen') / lines.length) * 40).toFixed(2)),
      cameraPer40: Number(
        (((effectCount('CameraMove') + effectCount('CameraZoom')) / lines.length) * 40).toFixed(2)
      )
    }
  }
}

export function aggregate(summaries) {
  const pick = (getter) => mean(summaries.map(getter))
  const distributions = Object.fromEntries(EMOTION_LABELS.map((label) => [label, 0]))
  for (const summary of summaries) {
    for (const label of EMOTION_LABELS)
      distributions[label] += summary.emotion.distribution[label] || 0
  }
  const totalEmotions = Object.values(distributions).reduce((sum, value) => sum + value, 0)
  return {
    windows: summaries.length,
    linesMean: Number(pick((summary) => summary.lines).toFixed(1)),
    estimatedSecondsMean: Number(pick((summary) => summary.estimatedSeconds).toFixed(0)),
    text: {
      charsTotalMean: Number(pick((summary) => summary.text.charsTotal).toFixed(0)),
      charsMean: Number(pick((summary) => summary.text.charsMean).toFixed(2)),
      charsP50: Number(pick((summary) => summary.text.charsP50).toFixed(1)),
      charsP90: Number(pick((summary) => summary.text.charsP90).toFixed(1)),
      shortShare: Number(pick((summary) => summary.text.shortShare).toFixed(3)),
      longShare: Number(pick((summary) => summary.text.longShare).toFixed(3)),
      newlineShare: Number(pick((summary) => summary.text.newlineShare).toFixed(3)),
      questionShare: Number(pick((summary) => summary.text.questionShare).toFixed(3)),
      exclaimShare: Number(pick((summary) => summary.text.exclaimShare).toFixed(3)),
      ellipsisShare: Number(pick((summary) => summary.text.ellipsisShare).toFixed(3))
    },
    turns: {
      speakerRunMean: Number(pick((summary) => summary.turns.speakerRunMean).toFixed(2)),
      speakerRunMax: Number(pick((summary) => summary.turns.speakerRunMax).toFixed(1)),
      soloRunShare: Number(pick((summary) => summary.turns.soloRunShare).toFixed(3)),
      longRunShare: Number(pick((summary) => summary.turns.longRunShare).toFixed(3))
    },
    acting: {
      speakerActionsMean: Number(pick((summary) => summary.acting.speakerActionsMean).toFixed(2)),
      noActionShare: Number(pick((summary) => summary.acting.noActionShare).toFixed(3)),
      oneActionShare: Number(pick((summary) => summary.acting.oneActionShare).toFixed(3)),
      multiActionShare: Number(pick((summary) => summary.acting.multiActionShare).toFixed(3)),
      listenerShare: Number(pick((summary) => summary.acting.listenerShare).toFixed(3))
    },
    emotion: {
      distribution: Object.fromEntries(
        Object.entries(distributions).map(([label, value]) => [
          label,
          Number((value / Math.max(1, totalEmotions)).toFixed(3))
        ])
      ),
      strongShare: Number(pick((summary) => summary.emotion.strongShare).toFixed(3)),
      changesPer40: Number(pick((summary) => summary.emotion.changesPer40).toFixed(2)),
      adjacentChangeShare: Number(
        pick((summary) => summary.emotion.adjacentChangeShare).toFixed(3)
      ),
      runMean: Number(pick((summary) => summary.emotion.runMean).toFixed(2))
    },
    stage: {
      stageMean: Number(pick((summary) => summary.stage.stageMean).toFixed(2)),
      soloShare: Number(pick((summary) => summary.stage.soloShare).toFixed(3)),
      backgrounds: Number(pick((summary) => summary.stage.backgrounds).toFixed(2)),
      bgChangesPer40: Number(pick((summary) => summary.stage.bgChangesPer40).toFixed(2)),
      appearsPer40: Number(pick((summary) => summary.stage.appearsPer40).toFixed(2)),
      clearsPer40: Number(pick((summary) => summary.stage.clearsPer40).toFixed(2)),
      movesPer40: Number(pick((summary) => summary.stage.movesPer40).toFixed(2)),
      sePer40: Number(pick((summary) => summary.stage.sePer40).toFixed(2)),
      bgmChangesPer40: Number(pick((summary) => summary.stage.bgmChangesPer40).toFixed(2)),
      ambientPer40: Number(pick((summary) => summary.stage.ambientPer40).toFixed(2)),
      cameraPer40: Number(pick((summary) => summary.stage.cameraPer40).toFixed(2))
    }
  }
}

export function printAggregate(label, result) {
  console.log(
    `\n## ${label} (${result.windows} windows, ~${result.linesMean} lines, ~${result.estimatedSecondsMean}s)`
  )
  console.log('text   ', JSON.stringify(result.text))
  console.log('turns  ', JSON.stringify(result.turns))
  console.log('acting ', JSON.stringify(result.acting))
  console.log('emotion', JSON.stringify(result.emotion))
  console.log('stage  ', JSON.stringify(result.stage))
}
