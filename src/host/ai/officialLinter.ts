/**
 * Stage 5：官方 PJSK 分布与结构 Linter（validateAndNormalizeStory 后置校验/修整）。
 *
 * 核查并修复 7 项官方演出硬不变量：
 * 1. Talk.delay == 0 占比 >= 85%（清掉机械 0.1/0.15s 小停顿，保留 >=0.5s 刻意留白）
 * 2. 零 ±100px Slow 滑入/滑出（原地淡入/淡出 from == to, offset: 0）
 * 3. LayoutAppear 带动作后 < 0.4s 内不重复触发同角色 body motion（避免双重抽搐）
 * 4. 转场（BlackOut / SideFade Out / SekaiOut / Telop）与静默动作前设 closeWindowOnFinish
 * 5. FlashbackIn/Out、SepiaIn/Out、SideFade Out/In、SekaiOut/In、ShakeScreen/Stop、Shader、Camera 闭合
 * 6. 动作与表情全部存在于实时 CatalogView 目录中
 * 7. Normal(<=2) 舞台人数与槽位无冲突（禁止 ThreeMode）
 */

import { snippetHasPreFence } from '../../common/export/snippetSemantics'
import {
  APPEAR_FADE_TOTAL_MS,
  AUTO_NEXT_PAGE_DELAY_MS,
  HIDE_IN_PLACE_TOTAL_MS,
  MOVE_SPEED_DURATION_MS,
  SEKAI_IN_PRE_DELAY_MS,
  SEKAI_OUT_PRE_DELAY_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  TELOP_TOTAL_MS,
  WORD_INTERVAL_FRAMES,
  FRAME_MS,
  normalizeEffectDurationMs
} from '../../common/official/timing'
import type { StoryData } from '../../common/types/Story'
import type { CatalogView } from './prompt'
import {
  enforceIrodoriEmojiBudget,
  sanitizeIrodoriCaption
} from '../../common/tts/irodori'
import { hasSpokenStageDirectionLeak, isStageDirectionParenthetical } from './dialogueLinter'
import {
  evaluateActingLineMatch,
  facialRoleToTenseState,
  inspectModelFacial,
  inspectModelMotion,
  isCalmReassureResolution,
  isCheerfulComedyContext,
  isFacialCompatibleWithLine,
  isMotionAutoPickAllowed,
  isMotionCompatibleWithLine,
  isPositiveOnlyFacial,
  isSmileLikeFacial,
  isSpecialOrStandingMotion,
  pickListenerFallbackFacial,
  pickMoodMatchedFacial,
  pickMoodMatchedMotion,
  recommendActingForLine,
  updateSceneTenseAfterTalk,
  type ActorTenseState,
  type DramaticContextMood,
  type SceneTenseTracker
} from './facialSemantics'
import { characterActingProfile } from './personas'
import { hasZeroWidthChars, stripZeroWidthChars } from './ttsText'

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

export interface OfficialLintMetrics {
  talkCount: number
  talkZeroDelayShare: number
  slow100SlideCount: number
  appearMotionClashCount: number
  missingWindowCloseBeforeTransitionCount: number
  unclosedEffects: string[]
  invalidCatalogAnimations: string[]
  inPlaceAppearShare: number
  inPlaceClearShare: number
  slideEntryExitCount: number
  staggeredListenerActionCount: number
  staggeredListenerMotionCount: number
  stageViolationCount: number
  duplicateBgmCount: number
}

export interface OfficialLintReport {
  passed: boolean
  issues: string[]
  warnings: string[]
  metrics: OfficialLintMetrics
}

function visibleChars(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length
}

const GENUINE_CALM_RESOLUTION_RE =
  /～♪|♪|太好了|好耶|哈哈|嘻嘻|松了口气|雨过天晴|终于放心|よかった|和好吧/
const SELF_BLAME_REGRET_TEXT_RE =
  /(?:为什么我|没能说出口|没能|对不起|抱歉|后悔|搞砸|都是我的错|别走|言い返せば|言えなかった)/
const STANDARD_CHINESE_EMOTIONS = new Set(['平静', '开心', '生气', '伤心', '害羞', '惊讶'])

/** 判断文本是否为整句括号内心独白（已排除舞台动作括号如「（微笑）」「（叹气）」）。 */
export function isInternalThoughtContent(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed || !/^[（(]/.test(trimmed) || !/[）)]$/.test(trimmed)) return false
  let depth = 0
  for (let idx = 0; idx < trimmed.length; idx++) {
    const ch = trimmed[idx]
    if (ch === '(' || ch === '（') depth += 1
    else if (ch === ')' || ch === '）') depth -= 1
    if (depth === 0 && idx < trimmed.length - 1) return false
    if (depth < 0) return false
  }
  if (depth !== 0) return false
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return false
  return !isStageDirectionParenthetical(inner)
}

/** 判断 Talk 片段是否显式标记了思考/内心独白模式（windowDisplayMode=Thinking 或 effect=Internal）。 */
export function isExplicitThinkingTalkSnippet(snippet: JsonRecord): boolean {
  if (str(snippet.type) !== 'Talk' || !isRecord(snippet.data)) return false
  return (
    str(snippet.data.windowDisplayMode) === 'Thinking' || str(snippet.data.effect) === 'Internal'
  )
}

/** 判断 Talk 片段是否为思考/内心独白（显式标记或过滤舞台动作括号后的整句括号心理描写）。 */
export function isThinkingTalkSnippet(snippet: JsonRecord): boolean {
  if (str(snippet.type) !== 'Talk' || !isRecord(snippet.data)) return false
  return (
    isExplicitThinkingTalkSnippet(snippet) || isInternalThoughtContent(str(snippet.data.content))
  )
}

export function isGenuineCalmResolution(content: string): boolean {
  return GENUINE_CALM_RESOLUTION_RE.test(content)
}

function setSnippetPreFence(snippet: JsonRecord, preFence: boolean): boolean {
  const prevWait = snippet.wait
  const prevPb = snippet.progressBehavior
  snippet.wait = preFence
  snippet.progressBehavior = preFence ? 'WaitFinished' : 'Now'
  return prevWait !== snippet.wait || prevPb !== snippet.progressBehavior
}

function prevNonInstantShaderIndex(snippets: JsonRecord[], idx: number): number {
  for (let j = idx - 1; j >= 0; j--) {
    const cur = snippets[j]
    if (str(cur?.type) === 'AttachCharacterShader' && !snippetHasPreFence(cur as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' })) {
      continue
    }
    return j
  }
  return -1
}

function isSplitClearInterveningCue(snippet: JsonRecord): boolean {
  const kind = str(snippet?.type)
  return (
    kind === 'PlaySe' ||
    kind === 'StopSe' ||
    kind === 'Wait' ||
    kind === 'ChangeBgm' ||
    kind === 'BgmVolume' ||
    kind === 'ShakeScreen' ||
    kind === 'StopShakeScreen' ||
    kind === 'ShakeWindow' ||
    kind === 'StopShakeWindow' ||
    kind === 'CameraZoom' ||
    kind === 'CameraMove' ||
    kind === 'AttachCharacterShader' ||
    kind === 'AmbientColor'
  )
}

function findSplitDuoClearRun(
  snippets: JsonRecord[],
  clearIdx: number
): { clearEnd: number; nextClearStart: number; nextClearEnd: number } | null {
  if (str(snippets[clearIdx]?.type) !== 'LayoutClear') return null
  let clearEnd = clearIdx
  while (clearEnd + 1 < snippets.length && str(snippets[clearEnd + 1]?.type) === 'LayoutClear') {
    clearEnd += 1
  }
  let scan = clearEnd + 1
  let sawNonShaderPauseOrSe = false
  while (scan < snippets.length && isSplitClearInterveningCue(snippets[scan])) {
    const k = str(snippets[scan]?.type)
    if (k === 'Wait' || k === 'PlaySe') sawNonShaderPauseOrSe = true
    scan += 1
  }
  if (!sawNonShaderPauseOrSe || scan >= snippets.length || str(snippets[scan]?.type) !== 'LayoutClear') {
    return null
  }
  const nextClearStart = scan
  let nextClearEnd = nextClearStart
  while (
    nextClearEnd + 1 < snippets.length &&
    str(snippets[nextClearEnd + 1]?.type) === 'LayoutClear'
  ) {
    nextClearEnd += 1
  }
  // 确认后面是切单人 Center（或黑屏收尾），且中间没有任何 Talk / Motion
  let after = nextClearEnd + 1
  while (
    after < snippets.length &&
    (isSplitClearInterveningCue(snippets[after]) ||
      str(snippets[after]?.type) === 'ChangeLayoutMode' ||
      str(snippets[after]?.type) === 'ChangeBackgroundImage')
  ) {
    after += 1
  }
  const afterSnippet = snippets[after]
  const nextType = str(afterSnippet?.type)
  const afterData = afterSnippet && isRecord(afterSnippet.data) ? afterSnippet.data : null
  const nextSide =
    nextType === 'LayoutAppear' && afterData && isRecord(afterData.to)
      ? str(afterData.to.side)
      : ''
  if ((nextType === 'LayoutAppear' && nextSide === 'Center') || nextType === 'BlackOut') {
    return { clearEnd, nextClearStart, nextClearEnd }
  }
  return null
}

/**
 * 统一规范舞台进出场（LayoutClear / LayoutAppear）时间栅栏与切镜顺序：
 * 1. 合并 Duo -> Solo Center 中间被 Wait/PlaySe 拆散的两次 LayoutClear（先双人一起淡出，再 Wait/PlaySe -> Center 淡入）；
 * 2. 若首句内心独白仍留在双人同框，而紧跟其后的第二句独白前才切单人 Center，则将整段切镜前置到第一句独白前；
 * 3. 首条 LayoutClear 强制 wait=true / progressBehavior='WaitFinished'（等前句 Talk 播完），后续成对 LayoutClear 强制 Now（同时淡出）；
 * 4. 首条 LayoutAppear 强制 wait=true / progressBehavior='WaitFinished'（等前序 LayoutClear 全部完成再淡入），后续成对 LayoutAppear 强制 Now。
 */
export function normalizeLayoutTransitionBarriers(
  snippets: JsonRecord[],
  warn?: (message: string) => void
): void {
  // 1) 合并被 Wait/PlaySe 拆散的 Duo -> Solo LayoutClear
  let coalescedCount = 0
  for (let i = 0; i < snippets.length; i++) {
    if (str(snippets[i]?.type) !== 'LayoutClear') continue
    const split = findSplitDuoClearRun(snippets, i)
    if (!split) continue
    const moved = snippets.splice(split.nextClearStart, split.nextClearEnd - split.nextClearStart + 1)
    snippets.splice(split.clearEnd + 1, 0, ...moved)
    coalescedCount += moved.length
    i = split.clearEnd + moved.length
  }
  if (coalescedCount > 0) {
    warn?.(`[Linter] 已合并 ${coalescedCount} 处 Duo->Center 中间被 Wait/PlaySe 拆散的 LayoutClear，确保双人同时先淡出`)
  }

  // 2) 将延迟到第二句才切 Center 的内心独白切镜前置到第一句独白之前
  let hoistedThinkingCuts = 0
  const visible = new Set<number>()
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    const kind = str(s?.type)
    const d = isRecord(s?.data) ? s.data : {}
    if (kind === 'LayoutAppear') {
      const mid = num(d.modelId, -1)
      if (mid !== -1) visible.add(mid)
      continue
    }
    if (kind === 'LayoutClear') {
      const mid = num(d.modelId, -1)
      if (mid !== -1) visible.delete(mid)
      continue
    }
    if (kind === 'Talk' && isThinkingTalkSnippet(s) && visible.size >= 2) {
      const speakerId = num(d.modelId, -1)
      let scan = i + 1
      while (
        scan < snippets.length &&
        (str(snippets[scan]?.type) === 'PlaySe' ||
          str(snippets[scan]?.type) === 'Wait' ||
          str(snippets[scan]?.type) === 'ChangeBgm')
      ) {
        scan += 1
      }
      if (scan < snippets.length && str(snippets[scan]?.type) === 'LayoutClear') {
        const transStart = scan
        while (scan < snippets.length && str(snippets[scan]?.type) === 'LayoutClear') scan += 1
        while (
          scan < snippets.length &&
          (isSplitClearInterveningCue(snippets[scan]) ||
            str(snippets[scan]?.type) === 'ChangeLayoutMode')
        ) {
          scan += 1
        }
        const appear = snippets[scan]
        const appearData = appear && isRecord(appear.data) ? appear.data : {}
        const appearTo = isRecord(appearData.to) ? appearData.to : {}
        if (
          str(appear?.type) === 'LayoutAppear' &&
          num(appearData.modelId, -1) === speakerId &&
          str(appearTo.side) === 'Center'
        ) {
          let nextTalkIdx = scan + 1
          while (nextTalkIdx < snippets.length && isSplitClearInterveningCue(snippets[nextTalkIdx])) {
            nextTalkIdx += 1
          }
          const nextTalk = snippets[nextTalkIdx]
          if (
            nextTalk &&
            str(nextTalk.type) === 'Talk' &&
            isThinkingTalkSnippet(nextTalk) &&
            isRecord(nextTalk.data) &&
            num(nextTalk.data.modelId, -1) === speakerId
          ) {
            const cutBlock = snippets.splice(transStart, scan - transStart + 1)
            snippets.splice(i, 0, ...cutBlock)
            // 清除已退场听者在这第一句独白上的反应动作
            if (Array.isArray(d.actions)) {
              const speakerOnly = d.actions.filter(
                (act) => isRecord(act) && num(act.modelId, speakerId) === speakerId
              )
              if (speakerOnly.length > 0) d.actions = speakerOnly
              else delete d.actions
            }
            hoistedThinkingCuts += 1
            // 回退索引以更新 visible 集合
            i -= 1
            continue
          }
        }
      }
    }
  }
  if (hoistedThinkingCuts > 0) {
    warn?.(`[Linter] 已将 ${hoistedThinkingCuts} 处延迟切单人 Center 的思考模式切镜前置到第一句独白之前`)
  }

  // 3) 强制 LayoutClear / LayoutAppear 的 WaitFinished / Now 栅栏语义
  let fixedBarriers = 0
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    const kind = str(s?.type)
    if (kind !== 'LayoutClear' && kind !== 'LayoutAppear') continue
    const prevIdx = prevNonInstantShaderIndex(snippets, i)
    const isFirstInRun = prevIdx < 0 || str(snippets[prevIdx]?.type) !== kind
    if (setSnippetPreFence(s, isFirstInRun)) {
      fixedBarriers += 1
    }
  }
  if (fixedBarriers > 0) {
    warn?.(`[Linter] 已修正 ${fixedBarriers} 处 LayoutClear/LayoutAppear 栅栏（首条 WaitFinished、成对次条 Now）`)
  }
}

interface TalkEmotionRecord {
  snippetIndex: number
  speakerId: number
  speakerPath?: string
  speakerFacial: string
  partnerFacials: Array<{ modelId: number; path?: string; facial: string }>
  content: string
  emotion: string
  sceneId: number
}

function getSpeakerFacialFromTalk(data: JsonRecord, speakerId: number): string {
  if (Array.isArray(data.actions)) {
    for (const act of data.actions) {
      if (!isRecord(act)) continue
      if (num(act.modelId, speakerId) === speakerId && str(act.facial).trim()) {
        return str(act.facial).trim()
      }
    }
  }
  return str(data.facial).trim()
}

function inferPromotedEmotionForTalk(
  rec: TalkEmotionRecord,
  talks: TalkEmotionRecord[],
  talkPos: number,
  canUse: (label: string) => boolean
): string | null {
  const emo = rec.emotion
  if (emo !== '平静' && emo !== '') return null
  if (emo === '' && talks.length < 3) return null
  if (isGenuineCalmResolution(rec.content)) return null

  const speakerRole = rec.speakerFacial
    ? inspectModelFacial(rec.speakerPath, rec.speakerFacial).role
    : 'other'
  if (emo === '' && speakerRole !== 'cry' && speakerRole !== 'sad') return null

  const hasPartnerCryOrSad = rec.partnerFacials.some((pf) => {
    const r = inspectModelFacial(pf.path, pf.facial).role
    return r === 'cry' || r === 'sad'
  })

  let hasSadBefore = false
  let sameSpeakerSadBefore = false
  for (let b = talkPos - 1; b >= Math.max(0, talkPos - 5); b--) {
    const prev = talks[b]
    if (prev.sceneId !== rec.sceneId || prev.emotion === '开心' || prev.emotion === '生气') break
    const pRole = prev.speakerFacial ? inspectModelFacial(prev.speakerPath, prev.speakerFacial).role : 'other'
    const isSadBeat = prev.emotion === '伤心' || pRole === 'cry' || pRole === 'sad'
    if (isSadBeat) {
      hasSadBefore = true
      if (prev.speakerId === rec.speakerId) sameSpeakerSadBefore = true
      break
    }
  }

  let hasSadAfter = false
  let sameSpeakerSadAfter = false
  for (let f = talkPos + 1; f <= Math.min(talks.length - 1, talkPos + 5); f++) {
    const nxt = talks[f]
    if (nxt.sceneId !== rec.sceneId || nxt.emotion === '开心' || nxt.emotion === '生气') break
    const nRole = nxt.speakerFacial ? inspectModelFacial(nxt.speakerPath, nxt.speakerFacial).role : 'other'
    const isSadBeat = nxt.emotion === '伤心' || nRole === 'cry' || nRole === 'sad'
    if (isSadBeat) {
      hasSadAfter = true
      if (nxt.speakerId === rec.speakerId) sameSpeakerSadAfter = true
      break
    }
  }

  const inSadArc = hasSadBefore && hasSadAfter
  const hasSadTextCue =
    SELF_BLAME_REGRET_TEXT_RE.test(rec.content) ||
    /(?:哭|泪|呜|窒息|受不了|害怕|难过|伤心|痛苦|逃避|现实|再见|安心|笑出来|温柔|顾虑)/.test(
      rec.content
    )

  if (speakerRole === 'cry' || speakerRole === 'tearful_smile') {
    return canUse('伤心') ? '伤心' : null
  }
  if (
    speakerRole === 'sad' ||
    speakerRole === 'cold_hollow' ||
    speakerRole === 'closed_troubled'
  ) {
    if (hasSadBefore || hasSadAfter || hasPartnerCryOrSad || hasSadTextCue) {
      return canUse('伤心') ? '伤心' : null
    }
    return null
  }
  if (speakerRole === 'angry') {
    if (SELF_BLAME_REGRET_TEXT_RE.test(rec.content) || inSadArc) {
      return canUse('伤心') ? '伤心' : null
    }
    return canUse('生气') ? '生气' : null
  }
  if (
    speakerRole === 'surprise' &&
    /[！!？?]/.test(rec.content) &&
    !inSadArc &&
    !hasPartnerCryOrSad
  ) {
    return canUse('惊讶') ? '惊讶' : null
  }
  if (
    (speakerRole === 'trouble' || speakerRole === 'closed_neutral' || speakerRole === 'other') &&
    inSadArc
  ) {
    return canUse('伤心') ? '伤心' : null
  }
  if (sameSpeakerSadBefore && (sameSpeakerSadAfter || hasPartnerCryOrSad)) {
    return canUse('伤心') ? '伤心' : null
  }
  if (
    hasPartnerCryOrSad &&
    /(?:对不起|抱歉|没办法|受不了|安心|笑出来|别走|求你|好想|顾虑|温柔)/.test(rec.content)
  ) {
    return canUse('伤心') ? '伤心' : null
  }
  return null
}

function collectTalkEmotionRecords(
  snippets: JsonRecord[],
  models?: JsonRecord[],
  view?: CatalogView
): TalkEmotionRecord[] {
  const pathById = new Map<number, string>()
  if (Array.isArray(models)) {
    for (const m of models) {
      if (!isRecord(m)) continue
      const id = num(m.id, -1)
      if (id !== -1 && str(m.model)) pathById.set(id, str(m.model))
    }
  }
  const getPath = (id: number): string | undefined =>
    pathById.get(id) ?? view?.modelById(id)?.path

  const onStageFacial = new Map<number, string>()
  const records: TalkEmotionRecord[] = []
  let sceneId = 0

  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    const kind = str(s?.type)
    const d = isRecord(s?.data) ? s.data : {}
    if (
      kind === 'BlackOut' ||
      kind === 'SekaiOut' ||
      (kind === 'SideFade' && str(d.mode).toLowerCase() === 'out') ||
      kind === 'ChangeBackgroundImage'
    ) {
      sceneId += 1
    } else if (kind === 'LayoutAppear') {
      const mid = num(d.modelId, -1)
      if (mid !== -1) onStageFacial.set(mid, str(d.facial).trim())
    } else if (kind === 'LayoutClear') {
      const mid = num(d.modelId, -1)
      if (mid !== -1) onStageFacial.delete(mid)
    } else if (kind === 'Move' || kind === 'Motion') {
      const mid = num(d.modelId, -1)
      if (mid !== -1 && str(d.facial).trim()) onStageFacial.set(mid, str(d.facial).trim())
    } else if (kind === 'Talk') {
      const speakerId = num(d.modelId, -1)
      const explicitSpeakerFacial = getSpeakerFacialFromTalk(d, speakerId)
      const speakerFacial = explicitSpeakerFacial || onStageFacial.get(speakerId) || ''
      if (speakerId !== -1 && explicitSpeakerFacial) {
        onStageFacial.set(speakerId, explicitSpeakerFacial)
      }
      if (Array.isArray(d.actions)) {
        for (const act of d.actions) {
          if (!isRecord(act)) continue
          const aid = num(act.modelId, speakerId)
          const af = str(act.facial).trim()
          if (aid !== -1 && af) onStageFacial.set(aid, af)
        }
      }
      const partnerFacials: Array<{ modelId: number; path?: string; facial: string }> = []
      for (const [aid, af] of onStageFacial.entries()) {
        if (aid !== speakerId && af) {
          partnerFacials.push({ modelId: aid, path: getPath(aid), facial: af })
        }
      }
      records.push({
        snippetIndex: i,
        speakerId,
        speakerPath: getPath(speakerId),
        speakerFacial,
        partnerFacials,
        content: str(d.content),
        emotion: str(d.emotion).trim(),
        sceneId
      })
    }
  }
  return records
}

/**
 * 防止哭戏/悲伤对峙途中情绪标签掉回「平静」，并将 Talk.data.emotion 与角色持续表情/语境对齐。
 */
export function syncTalkEmotionContinuity(
  snippets: JsonRecord[],
  options: {
    models?: JsonRecord[]
    view?: CatalogView
    allowedLabels?: string[]
    warn?: (message: string) => void
  } = {}
): number {
  const talks = collectTalkEmotionRecords(snippets, options.models, options.view)
  if (talks.length === 0) return 0

  const explicitLabels = (options.allowedLabels ?? []).map((l) => l.trim()).filter(Boolean)
  const usedEmotions = new Set(talks.map((t) => t.emotion).filter(Boolean))
  if (explicitLabels.length === 0 && usedEmotions.size === 0) return 0

  const canUse = (label: string): boolean => {
    if (explicitLabels.length > 0) return explicitLabels.includes(label)
    if (usedEmotions.has(label)) return true
    return [...usedEmotions].some((e) => STANDARD_CHINESE_EMOTIONS.has(e)) && STANDARD_CHINESE_EMOTIONS.has(label)
  }

  let fixed = 0
  for (let pos = 0; pos < talks.length; pos++) {
    const rec = talks[pos]
    const promoted = inferPromotedEmotionForTalk(rec, talks, pos, canUse)
    if (!promoted || promoted === rec.emotion) continue
    const snippet = snippets[rec.snippetIndex]
    if (isRecord(snippet) && isRecord(snippet.data)) {
      snippet.data.emotion = promoted
      rec.emotion = promoted
      fixed += 1
    }
  }
  if (fixed > 0) {
    options.warn?.(
      `[Linter] 已同步修复 ${fixed} 处哭戏/悲伤段落中掉回「平静」的 emotion 标签，保持配音情绪连贯`
    )
  }
  return fixed
}

function estimateTalkDurationSec(data: JsonRecord, windowOpen: boolean): number {
  const chars = visibleChars(str(data.content))
  const openSec = windowOpen ? 0 : TALK_WINDOW_OPEN_CLOSE_MS / 1000
  const typingSec = chars * ((WORD_INTERVAL_FRAMES * FRAME_MS) / 1000)
  return openSec + typingSec + AUTO_NEXT_PAGE_DELAY_MS / 1000
}

function estimateSnippetDurationSec(snippet: JsonRecord, windowOpen: boolean): number {
  const kind = str(snippet.type)
  const data = isRecord(snippet.data) ? snippet.data : {}
  switch (kind) {
    case 'LayoutAppear':
      return APPEAR_FADE_TOTAL_MS / 1000
    case 'LayoutClear': {
      const from = isRecord(data.from) ? data.from : {}
      const to = isRecord(data.to) ? data.to : {}
      const moved =
        str(from.side, 'Center') !== str(to.side, 'Center') ||
        num(from.offset) !== num(to.offset) ||
        Boolean(from.under) !== Boolean(to.under)
      if (!moved) return HIDE_IN_PLACE_TOTAL_MS / 1000
      const speed = str(data.moveSpeed, 'Normal') as keyof typeof MOVE_SPEED_DURATION_MS
      return (MOVE_SPEED_DURATION_MS[speed] ?? MOVE_SPEED_DURATION_MS.Normal) / 1000
    }
    case 'Move': {
      const speed = str(data.moveSpeed, 'Normal') as keyof typeof MOVE_SPEED_DURATION_MS
      return (MOVE_SPEED_DURATION_MS[speed] ?? MOVE_SPEED_DURATION_MS.Normal) / 1000
    }
    case 'BlackOut':
    case 'BlackIn':
    case 'SideFade':
    case 'BlurIn':
    case 'BlurOut':
      return normalizeEffectDurationMs(num(data.duration, 500), 500) / 1000
    case 'SekaiIn':
      return (
        (SEKAI_IN_PRE_DELAY_MS + normalizeEffectDurationMs(num(data.duration, 500), 500)) / 1000
      )
    case 'SekaiOut':
      return (
        (SEKAI_OUT_PRE_DELAY_MS + normalizeEffectDurationMs(num(data.duration, 500), 500)) / 1000
      )
    case 'Telop':
      return TELOP_TOTAL_MS / 1000
    case 'HideTalk':
      return TALK_WINDOW_OPEN_CLOSE_MS / 1000
    case 'Wait':
      return Math.max(0, num(data.duration, 500)) / 1000
    case 'Motion':
      return Array.isArray(data.actions) ? Math.max(0.1, num(data.duration, 2)) : 0
    case 'Talk':
      return estimateTalkDurationSec(data, windowOpen)
    default:
      return 0
  }
}

function isFadeOutOrClearTransition(snippet: JsonRecord): boolean {
  const kind = str(snippet.type)
  const data = isRecord(snippet.data) ? snippet.data : {}
  if (kind === 'BlackOut' || kind === 'SekaiOut') return true
  if (kind === 'SideFade' && str(data.mode, 'out').toLowerCase() === 'out') return true
  return false
}

/**
 * 判断片段是否为退场/转场前将被 `<400ms` 打断的孤立短 `Motion`：
 * - 非多拍/长时（`duration >= 0.6` 或 `actions.length >= 2`）独立动作表演片段；
 * - 属于句后/栅栏后独立执行（非官方 `wait: false` 句中叠播）；
 * - 之后在无任何 `Talk` 或 `Wait >= 600ms` 的情况下紧接同角色 `LayoutClear` 或 `BlackOut` / `SideFade Out` / `SekaiOut`。
 */
export function isTrailingInterruptedMotionSnippet(snippets: JsonRecord[], index: number): boolean {
  const snippet = snippets[index]
  if (!isRecord(snippet) || str(snippet.type) !== 'Motion') return false
  const data = isRecord(snippet.data) ? snippet.data : {}
  const actions = Array.isArray(data.actions) ? (data.actions as JsonRecord[]) : []
  const durationSec = num(data.duration, 0)
  if (actions.length >= 2 || durationSec >= 0.6) return false

  const targetIds = new Set<number>()
  const mainId = num(data.modelId, -1)
  if (mainId !== -1) targetIds.add(mainId)
  for (const act of actions) {
    if (!isRecord(act)) continue
    const aid = num(act.modelId, mainId)
    if (aid !== -1) targetIds.add(aid)
  }
  if (targetIds.size === 0) return false

  // 若是紧随未收窗 Talk 后的 wait:false 句中叠加动作（如官方 event_145_08 演出），不视作尾部短打断
  const hasFence = snippetHasPreFence(
    snippet as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' }
  )
  if (!hasFence) {
    for (let k = index - 1; k >= 0; k--) {
      const prev = snippets[k]
      const pKind = str(prev?.type)
      if (pKind === 'Motion' || pKind === 'PlaySe' || pKind === 'StopSe' || pKind === 'ChangeBgm' || pKind === 'BgmVolume') {
        continue
      }
      if (pKind === 'Talk' && isRecord(prev.data) && prev.data.closeWindowOnFinish !== true) {
        return false
      }
      break
    }
  }

  let accumWaitMs = 0
  for (let j = index + 1; j < snippets.length; j++) {
    const next = snippets[j]
    const nKind = str(next?.type)
    const nData = isRecord(next?.data) ? next.data : {}
    if (nKind === 'Talk') return false
    if (nKind === 'Wait') {
      accumWaitMs += Math.max(0, num(nData.duration, 0))
      if (accumWaitMs >= 600) return false
      continue
    }
    if (nKind === 'LayoutClear' && targetIds.has(num(nData.modelId, -1))) {
      return true
    }
    if (isFadeOutOrClearTransition(next)) {
      return true
    }
  }
  return false
}

function isTransitionOrBreak(snippet: JsonRecord): boolean {
  const kind = str(snippet.type)
  const data = isRecord(snippet.data) ? snippet.data : {}
  if (kind === 'BlackOut' || kind === 'SekaiOut' || kind === 'Telop' || kind === 'FullScreenText') {
    return true
  }
  if (kind === 'SideFade' && str(data.mode).toLowerCase() === 'out') return true
  if (kind === 'Wait' && num(data.duration, 0) >= 300) return true
  if (kind === 'LayoutClear') return true
  return false
}

function isSlow100Slide(snippet: JsonRecord): boolean {
  const kind = str(snippet.type)
  if (kind !== 'LayoutAppear' && kind !== 'LayoutClear' && kind !== 'Move') return false
  const data = isRecord(snippet.data) ? snippet.data : {}
  const from = isRecord(data.from) ? data.from : {}
  const to = isRecord(data.to) ? data.to : {}
  const fromOff = num(from.offset, 0)
  const toOff = num(to.offset, 0)
  const fromSide = str(from.side, 'Center')
  const toSide = str(to.side, 'Center')
  const moveSpeed = str(data.moveSpeed, 'Normal')
  if (kind === 'LayoutAppear' || kind === 'LayoutClear') {
    const hasLegacy100 =
      fromSide === toSide &&
      fromOff !== toOff &&
      (Math.abs(fromOff) === 100 || Math.abs(toOff) === 100)
    if (hasLegacy100 && moveSpeed === 'Slow') return true
    if (hasLegacy100) return true
  }
  return moveSpeed === 'Slow' && fromSide === toSide && Math.abs(fromOff - toOff) === 100
}

/** 对已构建或外部传入的剧本做只读官方合规检查。 */
export function lintOfficialStory(
  story: StoryData | JsonRecord,
  view?: CatalogView
): OfficialLintReport {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
  const issues: string[] = []
  const warnings: string[] = []

  const talks = snippets.filter((s) => s.type === 'Talk')
  const talkCount = talks.length
  const zeroDelays = talks.filter((s) => num(s.delay, 0) === 0).length
  const talkZeroDelayShare = talkCount > 0 ? zeroDelays / talkCount : 1
  if (talkCount > 0 && talkZeroDelayShare < 0.85) {
    issues.push(
      `Talk.delay == 0 占比 ${(talkZeroDelayShare * 100).toFixed(1)}% 低于 85%（${zeroDelays}/${talkCount}）`
    )
  }

  let slow100SlideCount = 0
  let appearCount = 0
  let inPlaceAppearCount = 0
  let clearCount = 0
  let inPlaceClearCount = 0
  let slideEntryExitCount = 0
  let staggeredListenerActionCount = 0
  let staggeredListenerMotionCount = 0
  let appearMotionClashCount = 0
  let missingWindowCloseBeforeTransitionCount = 0
  let stageViolationCount = 0
  let duplicateBgmCount = 0
  let seCount = 0
  const invalidCatalogAnimations: string[] = []

  const rawStoryBgm = (story as JsonRecord).bgm
  const initialBgmList = Array.isArray(rawStoryBgm) ? rawStoryBgm : []
  let currentBgmFile =
    initialBgmList.length > 0 && typeof initialBgmList[0] === 'string'
      ? initialBgmList[0].trim().toLowerCase()
      : ''

  const visible = new Map<number, { side: string; offset: number }>()
  let flashbackOpen = false
  let sepiaOpen = false
  let sideFadeCovered = false
  let sekaiCovered = false
  let shakeScreenActive = false
  let shakeWindowActive = false
  let cameraDirty = false
  const activeShaders = new Set<number>()

  let cursorSec = 0
  let runningEndSec = 0
  let windowOpen = false
  let lastTalkIndex = -1
  let layoutMode: 'Normal' | 'Three' = 'Normal'
  const lastAppearMotion = new Map<number, { timeSec: number; motion: string; facial: string }>()

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const kind = str(snippet.type)
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (isSlow100Slide(snippet)) {
      slow100SlideCount += 1
    }

    if (kind === 'LayoutClear' || kind === 'LayoutAppear') {
      const prevIdx = prevNonInstantShaderIndex(snippets, i)
      const isFirstInRun = prevIdx < 0 || str(snippets[prevIdx]?.type) !== kind
      const hasFence = snippetHasPreFence(
        snippet as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' }
      )
      if (isFirstInRun && !hasFence) {
        issues.push(
          `snippets[${i}] 首条 ${kind} 必须设 wait: true / progressBehavior: "WaitFinished"，避免在上一句未结束时提前执行或与前序切镜叠影`
        )
      } else if (!isFirstInRun && hasFence) {
        issues.push(
          `snippets[${i}] 连续成对的后续 ${kind} 应设 wait: false / progressBehavior: "Now"，确保角色同时淡入/淡出`
        )
      }
      if (kind === 'LayoutClear' && findSplitDuoClearRun(snippets, i)) {
        issues.push(
          `snippets[${i}] 双人切单人 Center 退场中间夹杂 Wait/PlaySe，应先同时 LayoutClear 双人后再执行停顿与 Center 淡入`
        )
      }
    }

    if (
      snippetHasPreFence(
        snippet as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' }
      )
    ) {
      cursorSec = Math.max(cursorSec, runningEndSec)
    }
    const startSec = cursorSec + Math.max(0, num(snippet.delay, 0))
    const durSec = estimateSnippetDurationSec(snippet, windowOpen)
    const endSec = startSec + durSec
    runningEndSec = Math.max(runningEndSec, endSec)

    if (windowOpen && isTransitionOrBreak(snippet)) {
      const prevTalk = lastTalkIndex >= 0 ? snippets[lastTalkIndex] : null
      const prevData = prevTalk && isRecord(prevTalk.data) ? prevTalk.data : null
      const closedByPrev = prevData?.closeWindowOnFinish === true
      if (!closedByPrev) {
        // 紧跟在对话后面的 BlackOut（不含开场第一条）或 SideFade/SekaiOut/Telop/静默动作需要先收窗
        if (!(kind === 'BlackOut' && lastTalkIndex < 0)) {
          missingWindowCloseBeforeTransitionCount += 1
        }
      }
    }

    if (kind === 'ChangeLayoutMode') {
      layoutMode = data.mode === 'Three' ? 'Three' : 'Normal'
      if (data.mode === 'Three') {
        stageViolationCount += 1
        issues.push(`snippets[${i}] 禁止使用 ThreeMode（官方剧集全为 Normal <=2 人模式）`)
      }
    } else if (kind === 'LayoutAppear') {
      appearCount += 1
      const from = isRecord(data.from) ? data.from : {}
      const to = isRecord(data.to) ? data.to : {}
      const fromSide = str(from.side, 'Center')
      const toSide = str(to.side, 'Center')
      if (fromSide === toSide && num(from.offset, 0) === num(to.offset, 0)) {
        inPlaceAppearCount += 1
      } else if (fromSide !== toSide) {
        slideEntryExitCount += 1
      }
      const modelId = num(data.modelId, -1)
      const side = str(to.side, 'Left')
      if (visible.size >= 2 && !visible.has(modelId)) {
        stageViolationCount += 1
      }
      for (const [otherId, pos] of visible) {
        if (otherId === modelId) continue
        if (pos.side === side || pos.side === 'Center' || side === 'Center') {
          stageViolationCount += 1
        }
      }
      visible.set(modelId, { side, offset: num(to.offset, 0) })
      if (str(data.motion).trim()) {
        lastAppearMotion.set(modelId, {
          timeSec: startSec,
          motion: str(data.motion).trim(),
          facial: str(data.facial)
        })
      }
    } else if (kind === 'LayoutClear') {
      clearCount += 1
      const from = isRecord(data.from) ? data.from : {}
      const to = isRecord(data.to) ? data.to : {}
      const fromSide = str(from.side, 'Center')
      const toSide = str(to.side, 'Center')
      if (fromSide === toSide && num(from.offset, 0) === num(to.offset, 0)) {
        inPlaceClearCount += 1
      } else if (fromSide !== toSide) {
        slideEntryExitCount += 1
      }
      const modelId = num(data.modelId, -1)
      visible.delete(modelId)
      lastAppearMotion.delete(modelId)
    } else if (kind === 'Move') {
      const modelId = num(data.modelId, -1)
      const to = isRecord(data.to) ? data.to : {}
      const side = str(to.side, 'Left')
      for (const [otherId, pos] of visible) {
        if (otherId === modelId) continue
        if (pos.side === side || pos.side === 'Center' || side === 'Center') {
          stageViolationCount += 1
        }
      }
      visible.set(modelId, { side, offset: num(to.offset, 0) })
    } else if (kind === 'Talk') {
      windowOpen = data.closeWindowOnFinish !== true
      lastTalkIndex = i
      const speakerId = num(data.modelId, -1)
      if (speakerId !== -1 && !visible.has(speakerId)) {
        stageViolationCount += 1
      }
      if (layoutMode === 'Normal' && visible.size >= 2) {
        if (isExplicitThinkingTalkSnippet(snippet)) {
          issues.push(
            `snippets[${i}] 思考模式台词仍在双人同台状态下播放，应先双人同时 LayoutClear 再 LayoutAppear(Center)`
          )
        } else if (isThinkingTalkSnippet(snippet)) {
          let scan = i + 1
          while (
            scan < snippets.length &&
            (str(snippets[scan]?.type) === 'PlaySe' ||
              str(snippets[scan]?.type) === 'Wait' ||
              str(snippets[scan]?.type) === 'ChangeBgm')
          ) {
            scan += 1
          }
          if (scan < snippets.length && str(snippets[scan]?.type) === 'LayoutClear') {
            while (scan < snippets.length && str(snippets[scan]?.type) === 'LayoutClear') scan += 1
            while (
              scan < snippets.length &&
              (isSplitClearInterveningCue(snippets[scan]) ||
                str(snippets[scan]?.type) === 'ChangeLayoutMode')
            ) {
              scan += 1
            }
            const app = snippets[scan]
            const appData = app && isRecord(app.data) ? app.data : {}
            const appTo = isRecord(appData.to) ? appData.to : {}
            if (
              str(app?.type) === 'LayoutAppear' &&
              num(appData.modelId, -1) === speakerId &&
              str(appTo.side) === 'Center'
            ) {
              issues.push(
                `snippets[${i}] 首句内心独白仍停留在双人槽位、直到后续才切 Center，应在第一句独白前先双人淡出再切 Center`
              )
            }
          }
        }
      }
      const checkActionTime = (modelId: number, motionName: string, atFrac: number): void => {
        if (!motionName) return
        const appearInfo = lastAppearMotion.get(modelId)
        if (!appearInfo || !appearInfo.motion) return
        const actionTime = startSec + atFrac * durSec
        if (actionTime - appearInfo.timeSec < 0.4 - 1e-6) {
          appearMotionClashCount += 1
        }
      }
      if (str(data.motion).trim()) {
        checkActionTime(speakerId, str(data.motion).trim(), 0)
      }
      if (Array.isArray(data.actions)) {
        for (const action of data.actions) {
          if (!isRecord(action)) continue
          const aid = num(action.modelId, speakerId)
          const atFrac = num(action.at, 0)
          const hasMotion = Boolean(str(action.motion).trim())
          if (hasMotion) {
            checkActionTime(aid, str(action.motion).trim(), atFrac)
          }
          if (aid !== speakerId && atFrac > 0.01) {
            staggeredListenerActionCount += 1
            if (hasMotion) {
              staggeredListenerMotionCount += 1
            }
          }
        }
      }
    } else if (kind === 'HideTalk') {
      windowOpen = false
    } else if (kind === 'Motion') {
      const mid = num(data.modelId, -1)
      if (str(data.motion).trim()) {
        const appearInfo = lastAppearMotion.get(mid)
        if (appearInfo && appearInfo.motion && startSec - appearInfo.timeSec < 0.4 - 1e-6) {
          appearMotionClashCount += 1
        }
      }
      if (isTrailingInterruptedMotionSnippet(snippets, i)) {
        issues.push(
          `snippets[${i}] 退场/转场前存在无后续台词的孤立短 Motion（${str(data.motion) || 'action'}），未播完即被清场/黑屏打断，应移除`
        )
      }
    } else if (kind === 'FlashbackIn') {
      flashbackOpen = true
    } else if (kind === 'FlashbackOut') {
      flashbackOpen = false
    } else if (kind === 'SepiaIn') {
      sepiaOpen = true
    } else if (kind === 'SepiaOut') {
      sepiaOpen = false
    } else if (kind === 'SideFade') {
      const mode = str(data.mode).toLowerCase()
      if (mode === 'out') sideFadeCovered = true
      else if (mode === 'in') sideFadeCovered = false
    } else if (kind === 'SekaiOut') {
      sekaiCovered = true
    } else if (kind === 'SekaiIn') {
      sekaiCovered = false
    } else if (kind === 'ShakeScreen') {
      if (num(data.duration, 0) >= 10000) shakeScreenActive = true
    } else if (kind === 'StopShakeScreen' || kind === 'StopShake') {
      shakeScreenActive = false
    } else if (kind === 'ShakeWindow') {
      if (num(data.duration, 0) >= 10000) shakeWindowActive = true
    } else if (kind === 'StopShakeWindow') {
      shakeWindowActive = false
    } else if (kind === 'AttachCharacterShader') {
      const mid = num(data.modelId, -1)
      if (str(data.shader) === 'none') activeShaders.delete(mid)
      else activeShaders.add(mid)
    } else if (kind === 'CameraZoom') {
      cameraDirty = Math.abs(num(data.scale, 1) - 1) > 0.01
    } else if (kind === 'CameraMove') {
      cameraDirty = Math.abs(num(data.x, 0)) > 0.5 || Math.abs(num(data.y, 0)) > 0.5
    } else if (kind === 'ChangeBgm') {
      if (data.stop === true) {
        currentBgmFile = ''
      } else {
        const bgmFile = str(data.file).trim()
        const normalized = bgmFile.toLowerCase()
        if (normalized) {
          if (normalized === currentBgmFile) {
            duplicateBgmCount += 1
            issues.push(`snippets[${i}] 重复触发相同 BGM（${bgmFile}），无需连续重播同一曲目`)
          } else {
            currentBgmFile = normalized
          }
        }
      }
    } else if (kind === 'Sound' || kind === 'PlaySe') {
      seCount += 1
    }

    // 实时 CatalogView 动作/表情有效性检查
    if (view) {
      const checkAnim = (modelId: number, field: 'motion' | 'facial', val: unknown): void => {
        const name = str(val).trim()
        if (!name || modelId === -1) return
        const choices = view.animationChoices(modelId, field)
        if (choices.size > 0 && !choices.has(name)) {
          invalidCatalogAnimations.push(`snippets[${i}].${field}=${name}(model=${modelId})`)
        }
      }
      if (['LayoutAppear', 'LayoutClear', 'Move', 'Motion', 'Talk'].includes(kind)) {
        const mid = num(data.modelId, -1)
        checkAnim(mid, 'motion', data.motion)
        checkAnim(mid, 'facial', data.facial)
        if (Array.isArray(data.actions)) {
          for (const action of data.actions) {
            if (!isRecord(action)) continue
            const aid = num(action.modelId, mid)
            checkAnim(aid, 'motion', action.motion)
            checkAnim(aid, 'facial', action.facial)
          }
        }
      }
    }
  }

  const unclosedEffects: string[] = []
  if (flashbackOpen) unclosedEffects.push('FlashbackIn 未配对 FlashbackOut')
  if (sepiaOpen) unclosedEffects.push('SepiaIn 未配对 SepiaOut')
  if (sideFadeCovered) unclosedEffects.push('SideFade Out 未配对 SideFade In')
  if (sekaiCovered) unclosedEffects.push('SekaiOut 未配对 SekaiIn')
  if (shakeScreenActive) unclosedEffects.push('长时 ShakeScreen 未配对 StopShakeScreen')
  if (shakeWindowActive) unclosedEffects.push('长时 ShakeWindow 未配对 StopShakeWindow')
  if (activeShaders.size > 0)
    unclosedEffects.push(`AttachCharacterShader 未在离场前清除 (${[...activeShaders].join(',')})`)
  if (cameraDirty) warnings.push('结尾前 CameraMove / CameraZoom 未复位为 (0,0)/1.0')

  if (slow100SlideCount > 0) issues.push(`存在 ${slow100SlideCount} 条 ±100px Slow 滑入/滑出`)
  if (appearMotionClashCount > 0)
    issues.push(`存在 ${appearMotionClashCount} 处入场 <0.4s 动作连打`)
  if (missingWindowCloseBeforeTransitionCount > 0) {
    issues.push(`存在 ${missingWindowCloseBeforeTransitionCount} 处转场/Telop/静默拍前未收窗`)
  }
  if (unclosedEffects.length > 0) issues.push(...unclosedEffects)
  if (invalidCatalogAnimations.length > 0) {
    issues.push(`存在未收录的动作/表情：${invalidCatalogAnimations.slice(0, 5).join(', ')}`)
  }
  if (stageViolationCount > 0) issues.push(`舞台槽位/人数违规 ${stageViolationCount} 处`)
  const inPlaceAppearShare = appearCount > 0 ? inPlaceAppearCount / appearCount : 1
  const inPlaceClearShare = clearCount > 0 ? inPlaceClearCount / clearCount : 1
  if (slideEntryExitCount > 0) {
    issues.push(
      `存在 ${slideEntryExitCount} 处滑动入场/退场（原地淡入占比 ${(inPlaceAppearShare * 100).toFixed(0)}%，原地淡出占比 ${(inPlaceClearShare * 100).toFixed(0)}%），一律要求槽位原地渐变（from.side === to.side, offset: 0）`
    )
  }
  if (staggeredListenerMotionCount > 0) {
    warnings.push(
      `存在 ${staggeredListenerMotionCount} 处句中错峰听者身体动作（at > 0），官方 PJSK 台词动作全在句首 at=0，听者建议用句首纯 facial 或独立 Motion 节拍`
    )
  }
  if (talkCount >= 15 && seCount === 0) {
    warnings.push(
      '长段剧情全程未配置任何 Sound/PlaySe 音效，建议在脚步/开门/提示音等物理节拍处适量点缀'
    )
  }

  // 检查哭戏/悲伤段落中 emotion 意外掉回「平静」
  const talkRecords = collectTalkEmotionRecords(
    snippets,
    Array.isArray(story.models) ? (story.models as JsonRecord[]) : undefined,
    view
  )
  const usedEmotions = new Set(talkRecords.map((t) => t.emotion).filter(Boolean))
  if (usedEmotions.size > 0) {
    const canUseStd = (label: string): boolean =>
      usedEmotions.has(label) ||
      ([...usedEmotions].some((e) => STANDARD_CHINESE_EMOTIONS.has(e)) &&
        STANDARD_CHINESE_EMOTIONS.has(label))
    for (let pos = 0; pos < talkRecords.length; pos++) {
      const rec = talkRecords[pos]
      if (rec.emotion !== '平静') continue
      const promoted = inferPromotedEmotionForTalk(rec, talkRecords, pos, canUseStd)
      if (promoted === '伤心') {
        issues.push(
          `snippets[${rec.snippetIndex}] 处于哭泣/悲伤语境（facial=${rec.speakerFacial || '无'}）却掉回 emotion="平静"，应保持为「伤心」`
        )
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    metrics: {
      talkCount,
      talkZeroDelayShare: Number(talkZeroDelayShare.toFixed(3)),
      slow100SlideCount,
      appearMotionClashCount,
      missingWindowCloseBeforeTransitionCount,
      unclosedEffects,
      invalidCatalogAnimations,
      inPlaceAppearShare: Number(inPlaceAppearShare.toFixed(3)),
      inPlaceClearShare: Number(inPlaceClearShare.toFixed(3)),
      slideEntryExitCount,
      staggeredListenerActionCount,
      staggeredListenerMotionCount,
      stageViolationCount,
      duplicateBgmCount
    }
  }
}

function resolveActorCatalogInfo(
  story: JsonRecord,
  modelId: number,
  view?: CatalogView
): { path?: string; facials: string[]; motions: string[]; restrained: boolean } {
  const catalogModel = view?.modelById(modelId)
  if (catalogModel) {
    const promptF = view!.promptFacials(catalogModel)
    const promptM = view!.promptMotions(catalogModel)
    const facials = [...promptF, ...catalogModel.facials.filter((f) => !promptF.includes(f))]
    const motions = [...promptM, ...catalogModel.motions.filter((m) => !promptM.includes(m))].filter(
      (m) => isMotionAutoPickAllowed(m, catalogModel.path)
    )
    return {
      path: catalogModel.path,
      facials,
      motions,
      restrained: characterActingProfile(`${catalogModel.name} ${catalogModel.path}`).restrained
    }
  }
  const models = Array.isArray(story.models) ? (story.models as JsonRecord[]) : []
  const modelRec = models.find((m) => isRecord(m) && num(m.id, -1) === modelId)
  const modelPath = modelRec ? str(modelRec.model) || undefined : undefined
  const modelName = modelRec ? str(modelRec.name) : ''
  return {
    path: modelPath,
    facials: [],
    motions: [],
    restrained: characterActingProfile(`${modelName} ${modelPath ?? ''}`).restrained
  }
}

function updateActorStateOnTalkOrStage(
  actorState: Map<number, ActorTenseState>,
  modelId: number,
  modelPath: string | undefined,
  facial: string,
  emotion?: string,
  content?: string
): void {
  if (modelId === -1) return
  const emo = (emotion ?? '').trim()
  if (content !== undefined && isCalmReassureResolution(content, emo)) {
    actorState.set(modelId, null)
    return
  }
  if (emo === '生气') {
    actorState.set(modelId, 'angry')
    return
  }
  if (emo === '伤心' || emo === '害怕') {
    const fRole = facial ? inspectModelFacial(modelPath, facial).role : 'other'
    actorState.set(modelId, fRole === 'cry' || fRole === 'tearful_smile' ? 'cry' : 'sad')
    return
  }
  if (!facial) return
  const fRole = inspectModelFacial(modelPath, facial).role
  const derived = facialRoleToTenseState(fRole)
  if (derived) {
    actorState.set(modelId, derived)
  } else if (fRole === 'genuine_smile' || fRole === 'closed_smile' || fRole === 'playful') {
    actorState.set(modelId, null)
  }
}

function pickVerifiedReplacementMotion(
  actorInfo: { path?: string; facials: string[]; motions: string[]; restrained: boolean },
  params: {
    modelId: number
    content: string
    emotion: string
    prevContent?: string
    prevEmotion?: string
    prevTense: boolean
    isListener: boolean
    avoidMotion: string
    cheerfulScene?: boolean
    fallbackMood: 'angry_frustration' | 'sad_regret' | 'awkward' | 'neutral'
  },
  view?: CatalogView
): string {
  const pool = actorInfo.motions.filter((m) => m !== params.avoidMotion && !isSpecialOrStandingMotion(m))
  const rec = recommendActingForLine({
    facials: actorInfo.facials,
    motions: pool,
    modelPath: actorInfo.path,
    content: params.content,
    emotion: params.emotion,
    prevContent: params.prevContent,
    prevEmotion: params.prevEmotion,
    prevTense: params.prevTense,
    isListener: params.isListener,
    restrainedRole: actorInfo.restrained
  })
  const compat = rec.motions.find((m) =>
    isMotionCompatibleWithLine({
      motion: m,
      modelPath: actorInfo.path,
      emotion: params.emotion,
      content: params.content,
      prevContent: params.prevContent,
      prevEmotion: params.prevEmotion,
      prevTense: params.prevTense,
      isListener: params.isListener,
      restrainedRole: actorInfo.restrained,
      cheerfulScene: params.cheerfulScene
    }).ok
  )
  const compatFromPool =
    compat ||
    pool.find(
      (m) =>
        !isSpecialOrStandingMotion(m) &&
        isMotionCompatibleWithLine({
          motion: m,
          modelPath: actorInfo.path,
          emotion: params.emotion,
          content: params.content,
          prevContent: params.prevContent,
          prevEmotion: params.prevEmotion,
          prevTense: params.prevTense,
          isListener: params.isListener,
          restrainedRole: actorInfo.restrained,
          cheerfulScene: params.cheerfulScene
        }).ok
    )
  const rawPick =
    compatFromPool ||
    pickMoodMatchedMotion(
      pool,
      params.fallbackMood,
      actorInfo.path,
      actorInfo.restrained,
      [params.avoidMotion]
    )
  if (!rawPick) return ''
  if (view && params.modelId !== -1) {
    const choices = view.animationChoices(params.modelId, 'motion')
    if (choices.size > 0) return view.canonicalAnimation(params.modelId, 'motion', rawPick) ?? ''
  }
  return rawPick
}

function repairActingHygieneInvariants(
  story: JsonRecord,
  view: CatalogView | undefined,
  warn: (message: string) => void
): void {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []

  // A) 移除退场/黑屏前无后续台词的孤立短 Motion（避免 <400ms 被 LayoutClear/LayoutAppear 打断）
  let removedTrailingMotions = 0
  for (let i = snippets.length - 1; i >= 0; i--) {
    if (isTrailingInterruptedMotionSnippet(snippets, i)) {
      snippets.splice(i, 1)
      removedTrailingMotions += 1
    }
  }
  if (removedTrailingMotions > 0) {
    warn(`[Linter] 已移除 ${removedTrailingMotions} 处退场/转场前将被打断的孤立短 Motion`)
  }

  // B) 语境限定动作校验、听者强制微笑防泄漏、以及紧张对峙强装欢快纠偏
  const tenseTracker: SceneTenseTracker = { tense: false, calmRun: 0 }
  const actorState = new Map<number, ActorTenseState>()
  let prevContent = ''
  let prevEmotion = ''
  let repairedListenerSmiles = 0
  let repairedMotions = 0
  let repairedFacials = 0

  const talkRecordsForComedy = collectTalkEmotionRecords(
    snippets,
    Array.isArray(story.models) ? (story.models as JsonRecord[]) : undefined,
    view
  )
  const comedyProbeLines = talkRecordsForComedy.map((rec) => ({
    content: rec.content,
    emotion: rec.emotion,
    sceneId: String(rec.sceneId)
  }))
  const talkPosBySnippet = new Map<number, number>()
  talkRecordsForComedy.forEach((rec, pos) => talkPosBySnippet.set(rec.snippetIndex, pos))

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    if (!isRecord(snippet) || !isRecord(snippet.data)) continue
    const kind = str(snippet.type)
    const data = snippet.data

    if (isFadeOutOrClearTransition(snippet) || kind === 'ChangeBackgroundImage') {
      tenseTracker.tense = false
      tenseTracker.calmRun = 0
      prevContent = ''
      prevEmotion = ''
      actorState.clear()
      continue
    }

    if (kind === 'LayoutAppear' || kind === 'Move') {
      const mid = num(data.modelId, -1)
      const actorInfo = resolveActorCatalogInfo(story, mid, view)
      const surrounding = findSurroundingTalkContext(snippets, i, mid, kind === 'LayoutAppear')
      const stageFacial = str(data.facial).trim()
      if (stageFacial && surrounding) {
        const fc = isFacialCompatibleWithLine({
          facial: stageFacial,
          modelPath: actorInfo.path,
          emotion: surrounding.emotion,
          content: surrounding.content,
          prevTense: tenseTracker.tense,
          isMonologue: false,
          isListener: false,
          restrainedRole: actorInfo.restrained
        })
        if (!fc.ok) {
          const rec = recommendActingForLine({
            facials: actorInfo.facials,
            motions: [],
            modelPath: actorInfo.path,
            content: surrounding.content,
            emotion: surrounding.emotion,
            prevTense: tenseTracker.tense,
            restrainedRole: actorInfo.restrained,
            prevFacial: stageFacial
          })
          let rep =
            rec.facials.find((f) => f !== stageFacial) ??
            (actorInfo.facials.length > 0
              ? pickMoodMatchedFacial(
                  actorInfo.facials,
                  tenseTracker.tense ? 'serious' : 'neutral',
                  actorInfo.path,
                  actorInfo.restrained
                )
              : '')
          if (rep && view && mid !== -1) {
            const choices = view.animationChoices(mid, 'facial')
            if (choices.size > 0) rep = view.canonicalAnimation(mid, 'facial', rep) ?? ''
          }
          if (rep && rep !== stageFacial) {
            data.facial = rep
            repairedFacials += 1
          }
        }
      }
      const mot = str(data.motion).trim()
      if (mot) {
        const mc = isMotionCompatibleWithLine({
          motion: mot,
          modelPath: actorInfo.path,
          emotion: surrounding?.emotion ?? '',
          content: surrounding?.content ?? '',
          prevTense: tenseTracker.tense,
          restrainedRole: actorInfo.restrained
        })
        if (!mc.ok) {
          data.motion = pickVerifiedReplacementMotion(
            actorInfo,
            {
              modelId: mid,
              content: surrounding?.content ?? '',
              emotion: surrounding?.emotion ?? '',
              prevTense: tenseTracker.tense,
              isListener: false,
              avoidMotion: mot,
              fallbackMood: tenseTracker.tense ? 'awkward' : 'neutral'
            },
            view
          )
          repairedMotions += 1
        }
      }
      updateActorStateOnTalkOrStage(actorState, mid, actorInfo.path, str(data.facial).trim())
      continue
    }

    if (kind === 'Motion') {
      const mid = num(data.modelId, -1)
      const surrounding = findSurroundingTalkContext(snippets, i, mid, false)
      const checkMotionTarget = (target: JsonRecord, targetId: number): void => {
        const info = resolveActorCatalogInfo(story, targetId, view)
        const tf = str(target.facial).trim()
        if (tf && surrounding) {
          const fc = isFacialCompatibleWithLine({
            facial: tf,
            modelPath: info.path,
            emotion: surrounding.emotion,
            content: surrounding.content,
            prevTense: tenseTracker.tense,
            isMonologue: false,
            isListener: false,
            restrainedRole: info.restrained
          })
          if (!fc.ok) {
            const rec = recommendActingForLine({
              facials: info.facials,
              motions: [],
              modelPath: info.path,
              content: surrounding.content,
              emotion: surrounding.emotion,
              prevTense: tenseTracker.tense,
              restrainedRole: info.restrained,
              prevFacial: tf
            })
            let rep =
              rec.facials.find((f) => f !== tf) ??
              (info.facials.length > 0
                ? pickMoodMatchedFacial(
                    info.facials,
                    tenseTracker.tense ? 'serious' : 'neutral',
                    info.path,
                    info.restrained
                  )
                : '')
            if (rep && view && targetId !== -1) {
              const choices = view.animationChoices(targetId, 'facial')
              if (choices.size > 0) rep = view.canonicalAnimation(targetId, 'facial', rep) ?? ''
            }
            if (rep && rep !== tf) {
              target.facial = rep
              repairedFacials += 1
            }
          }
        }
        const mot = str(target.motion).trim()
        if (mot) {
          const mc = isMotionCompatibleWithLine({
            motion: mot,
            modelPath: info.path,
            emotion: surrounding?.emotion ?? '',
            content: surrounding?.content ?? '',
            prevTense: tenseTracker.tense,
            restrainedRole: info.restrained
          })
          if (!mc.ok) {
            const rep = pickVerifiedReplacementMotion(
              info,
              {
                modelId: targetId,
                content: surrounding?.content ?? '',
                emotion: surrounding?.emotion ?? '',
                prevTense: tenseTracker.tense,
                isListener: false,
                avoidMotion: mot,
                fallbackMood: tenseTracker.tense ? 'awkward' : 'neutral'
              },
              view
            )
            if (rep) target.motion = rep
            else delete target.motion
            repairedMotions += 1
          }
        }
        updateActorStateOnTalkOrStage(actorState, targetId, info.path, str(target.facial).trim())
      }
      checkMotionTarget(data, mid)
      if (Array.isArray(data.actions)) {
        for (const act of data.actions) {
          if (!isRecord(act)) continue
          checkMotionTarget(act, num(act.modelId, mid))
        }
      }
      continue
    }

    if (kind !== 'Talk') continue

    const speakerId = num(data.modelId, -1)
    const content = str(data.content)
    const emotion = str(data.emotion)
    const isMonologue = isThinkingTalkSnippet(snippet)
    const talkPos = talkPosBySnippet.get(i) ?? -1
    const cheerfulScene =
      talkPos >= 0 ? isCheerfulComedyContext(comedyProbeLines, talkPos) : false
    const effectivePrevTense = tenseTracker.tense && !cheerfulScene

    const fixTarget = (target: JsonRecord, actorId: number, isListener: boolean): void => {
      if (actorId === -1) return
      const actorInfo = resolveActorCatalogInfo(story, actorId, view)
      const facial = str(target.facial).trim()
      const motion = str(target.motion).trim()

      // 1) 听者情绪一致性：怒/悲/泣/严肃状态的听者在未和好前严禁瞬切 genuine_smile / closed_smile / playful / glad
      if (isListener) {
        const lState = actorState.get(actorId) ?? null
        const isLockedTenseListener =
          !(cheerfulScene && emotion === '开心') &&
          (lState === 'angry' ||
            lState === 'sad' ||
            lState === 'cry' ||
            lState === 'serious' ||
            (lState === 'trouble' && effectivePrevTense))
        if (isLockedTenseListener && lState) {
          const isListenerSmile =
            facial &&
            (isPositiveOnlyFacial(facial, actorInfo.path) ||
              (lState === 'angry' && isSmileLikeFacial(facial, actorInfo.path)))
          if (isListenerSmile) {
            let repFacial =
              actorInfo.facials.length > 0
                ? pickListenerFallbackFacial(
                    actorInfo.facials,
                    lState,
                    actorInfo.path,
                    actorInfo.restrained
                  )
                : lState === 'sad' || lState === 'cry'
                  ? 'face_sad_01'
                  : lState === 'trouble'
                    ? 'face_trouble_01'
                    : 'face_serious_01'
            if (view) {
              const choices = view.animationChoices(actorId, 'facial')
              if (choices.size > 0) {
                repFacial = view.canonicalAnimation(actorId, 'facial', repFacial) ?? ''
              }
            }
            if (repFacial && repFacial !== facial) {
              target.facial = repFacial
              repairedListenerSmiles += 1
            }
          }
          if (motion) {
            const mRole = inspectModelMotion(actorInfo.path, motion).role
            if (mRole === 'glad' || mRole === 'playful' || mRole === 'greeting') {
              const repMot = pickVerifiedReplacementMotion(
                actorInfo,
                {
                  modelId: actorId,
                  content,
                  emotion,
                  prevContent,
                  prevEmotion,
                  prevTense: true,
                  isListener: true,
                  avoidMotion: motion,
                  cheerfulScene,
                  fallbackMood:
                    lState === 'angry' || lState === 'serious' ? 'angry_frustration' : 'sad_regret'
                },
                view
              )
              if (repMot) target.motion = repMot
              else delete target.motion
              repairedMotions += 1
            }
          }
        }
      }

      // 2) 通用台词表情/动作兼容性（含 food/sleep/sing 上下文检查与对峙期强装欢快纠偏）
      const curFacial = str(target.facial).trim()
      if (
        curFacial &&
        !isFacialCompatibleWithLine({
          facial: curFacial,
          modelPath: actorInfo.path,
          emotion,
          content,
          prevTense: effectivePrevTense,
          isMonologue: !isListener && isMonologue,
          isListener,
          restrainedRole: actorInfo.restrained,
          cheerfulScene
        }).ok
      ) {
        const rec = recommendActingForLine({
          facials: actorInfo.facials,
          motions: actorInfo.motions,
          modelPath: actorInfo.path,
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense: effectivePrevTense,
          isMonologue: !isListener && isMonologue,
          isListener,
          restrainedRole: actorInfo.restrained,
          prevFacial: curFacial
        })
        let rep =
          rec.facials.find((f) => f !== curFacial) ??
          (actorInfo.facials.length > 0
            ? pickMoodMatchedFacial(
                actorInfo.facials,
                effectivePrevTense
                  ? emotion === '开心' && !isListener
                    ? 'wry_smile'
                    : 'serious'
                  : 'neutral',
                actorInfo.path,
                actorInfo.restrained
              )
            : '')
        if (rep && view) {
          const choices = view.animationChoices(actorId, 'facial')
          if (choices.size > 0) rep = view.canonicalAnimation(actorId, 'facial', rep) ?? ''
        }
        if (rep && rep !== curFacial) {
          target.facial = rep
          repairedFacials += 1
        }
      }

      const curMotion = str(target.motion).trim()
      if (
        curMotion &&
        !isMotionCompatibleWithLine({
          motion: curMotion,
          modelPath: actorInfo.path,
          emotion,
          content,
          prevContent,
          prevEmotion,
          prevTense: effectivePrevTense,
          isListener,
          restrainedRole: actorInfo.restrained,
          cheerfulScene
        }).ok
      ) {
        const rep = pickVerifiedReplacementMotion(
          actorInfo,
          {
            modelId: actorId,
            content,
            emotion,
            prevContent,
            prevEmotion,
            prevTense: effectivePrevTense,
            isListener,
            avoidMotion: curMotion,
            cheerfulScene,
            fallbackMood: effectivePrevTense ? 'awkward' : 'neutral'
          },
          view
        )
        if (rep && rep !== curMotion) {
          target.motion = rep
        } else if (target === data) {
          target.motion = ''
        } else {
          delete target.motion
        }
        repairedMotions += 1
      }
    }

    fixTarget(data, speakerId, false)
    if (Array.isArray(data.actions)) {
      for (const act of data.actions) {
        if (!isRecord(act)) continue
        const aid = num(act.modelId, speakerId)
        fixTarget(act, aid, aid !== speakerId)
      }
    }

    // 更新说话者与有动作听者的状态
    const effectiveSpeakerFacial = getSpeakerFacialFromTalk(data, speakerId)
    const speakerInfo = resolveActorCatalogInfo(story, speakerId, view)
    updateActorStateOnTalkOrStage(
      actorState,
      speakerId,
      speakerInfo.path,
      effectiveSpeakerFacial,
      emotion,
      content
    )
    if (Array.isArray(data.actions)) {
      for (const act of data.actions) {
        if (!isRecord(act)) continue
        const aid = num(act.modelId, speakerId)
        if (aid === speakerId || aid === -1) continue
        const lf = str(act.facial).trim()
        if (lf) {
          const lInfo = resolveActorCatalogInfo(story, aid, view)
          updateActorStateOnTalkOrStage(actorState, aid, lInfo.path, lf)
        }
      }
    }
    prevContent = content
    prevEmotion = emotion
    updateSceneTenseAfterTalk(tenseTracker, content, emotion, { cheerfulScene })
  }

  if (repairedListenerSmiles > 0) {
    warn(`[Linter] 已拦截并修正 ${repairedListenerSmiles} 处怒/悲/严肃状态听者突兀切回笑脸`)
  }
  if (repairedMotions > 0) {
    warn(`[Linter] 已替换 ${repairedMotions} 处语境不匹配或对峙期失真的身体动作`)
  }
  if (repairedFacials > 0) {
    warn(`[Linter] 已替换 ${repairedFacials} 处语境不匹配的表情`)
  }
}

function ensureEveryActorHasBodyMotion(
  story: JsonRecord,
  view: CatalogView,
  warn: (message: string) => void
): void {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
  const models = Array.isArray(story.models) ? (story.models as JsonRecord[]) : []
  if (models.length === 0) return

  const bodyCounts = new Map<number, number>()
  for (const m of models) {
    const id = num(m.id, -1)
    if (id !== -1) bodyCounts.set(id, 0)
  }

  let talkCount = 0
  let cursorSec = 0
  let runningEndSec = 0
  let windowOpen = false
  const lastAppearMotion = new Map<number, { timeSec: number; snippetIndex: number }>()
  const onStage = new Set<number>()
  const talkCandidates = new Map<
    number,
    Array<{
      snippetIndex: number
      clashesAppearIdx: number | null
      hasListenerMotionAtZero: boolean
      content: string
      emotion: string
      prevContent: string
      prevEmotion: string
      prevTense: boolean
    }>
  >()
  const stageFollowupCandidates = new Map<
    number,
    Array<{ insertAfterIndex: number; content: string; emotion: string; prevTense: boolean }>
  >()

  const tenseTracker: SceneTenseTracker = { tense: false, calmRun: 0 }
  let prevContent = ''
  let prevEmotion = ''

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    if (!isRecord(snippet)) continue
    const kind = str(snippet.type)
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (
      snippetHasPreFence(
        snippet as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' }
      )
    ) {
      cursorSec = Math.max(cursorSec, runningEndSec)
    }
    const startSec = cursorSec + Math.max(0, num(snippet.delay, 0))
    const durSec = estimateSnippetDurationSec(snippet, windowOpen)
    runningEndSec = Math.max(runningEndSec, startSec + durSec)

    if (isFadeOutOrClearTransition(snippet) || kind === 'ChangeBackgroundImage') {
      tenseTracker.tense = false
      tenseTracker.calmRun = 0
      prevContent = ''
      prevEmotion = ''
    }

    if (kind === 'LayoutAppear') {
      const mid = num(data.modelId, -1)
      if (mid !== -1) {
        onStage.add(mid)
        if (str(data.motion).trim()) {
          lastAppearMotion.set(mid, { timeSec: startSec, snippetIndex: i })
        } else {
          lastAppearMotion.delete(mid)
        }
      }
    } else if (kind === 'LayoutClear') {
      const mid = num(data.modelId, -1)
      onStage.delete(mid)
      lastAppearMotion.delete(mid)
    } else if (kind === 'Move') {
      const mid = num(data.modelId, -1)
      if (str(data.motion).trim() && bodyCounts.has(mid)) {
        bodyCounts.set(mid, (bodyCounts.get(mid) ?? 0) + 1)
      }
    } else if (kind === 'Motion') {
      const mid = num(data.modelId, -1)
      if (str(data.motion).trim() && bodyCounts.has(mid)) {
        bodyCounts.set(mid, (bodyCounts.get(mid) ?? 0) + 1)
      }
      if (Array.isArray(data.actions)) {
        for (const act of data.actions) {
          if (!isRecord(act)) continue
          const aid = num(act.modelId, mid)
          if (str(act.motion).trim() && bodyCounts.has(aid)) {
            bodyCounts.set(aid, (bodyCounts.get(aid) ?? 0) + 1)
          }
        }
      }
    } else if (kind === 'HideTalk') {
      windowOpen = false
    } else if (kind === 'Talk') {
      talkCount += 1
      windowOpen = data.closeWindowOnFinish !== true
      const speakerId = num(data.modelId, -1)
      const content = str(data.content)
      const emotion = str(data.emotion)
      const acts = Array.isArray(data.actions) ? (data.actions as JsonRecord[]) : []
      if (str(data.motion).trim() && bodyCounts.has(speakerId)) {
        bodyCounts.set(speakerId, (bodyCounts.get(speakerId) ?? 0) + 1)
      }
      let hasListenerMotionAtZero = false
      for (const act of acts) {
        if (!isRecord(act)) continue
        const aid = num(act.modelId, speakerId)
        if (str(act.motion).trim()) {
          if (bodyCounts.has(aid)) bodyCounts.set(aid, (bodyCounts.get(aid) ?? 0) + 1)
          if (aid !== speakerId && num(act.at, 0) < 0.25) hasListenerMotionAtZero = true
        }
      }

      if (speakerId !== -1 && bodyCounts.has(speakerId)) {
        const appearInfo = lastAppearMotion.get(speakerId)
        const clashesAppearIdx =
          appearInfo && startSec - appearInfo.timeSec < 0.4 - 1e-6 ? appearInfo.snippetIndex : null
        const list = talkCandidates.get(speakerId) ?? []
        list.push({
          snippetIndex: i,
          clashesAppearIdx,
          hasListenerMotionAtZero,
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense: tenseTracker.tense
        })
        talkCandidates.set(speakerId, list)
      }

      // 记录不马上退场/切幕的在场位置，供无台词龙套角色插入独立 Motion
      if (!data.closeWindowOnFinish) {
        const next = snippets[i + 1]
        const nKind = str(next?.type)
        if (nKind === 'Talk') {
          for (const aid of onStage) {
            if (!bodyCounts.has(aid)) continue
            const list = stageFollowupCandidates.get(aid) ?? []
            list.push({
              insertAfterIndex: i,
              content,
              emotion,
              prevTense: tenseTracker.tense
            })
            stageFollowupCandidates.set(aid, list)
          }
        }
      }

      prevContent = content
      prevEmotion = emotion
      updateSceneTenseAfterTalk(tenseTracker, content, emotion)
    }
  }

  if (talkCount < 6) return

  const zeroIds = [...bodyCounts.entries()].filter(([, cnt]) => cnt === 0).map(([id]) => id)
  if (zeroIds.length === 0) return

  let fixedActors = 0
  const pendingInserts: Array<{ afterIdx: number; snippet: JsonRecord }> = []

  for (const mid of zeroIds) {
    const actorInfo = resolveActorCatalogInfo(story, mid, view)
    const talksForActor = talkCandidates.get(mid) ?? []
    const cleanTalk =
      talksForActor.find((t) => t.clashesAppearIdx === null && !t.hasListenerMotionAtZero) ??
      talksForActor.find((t) => !t.hasListenerMotionAtZero) ??
      talksForActor[0]

    if (cleanTalk) {
      const motion = pickVerifiedReplacementMotion(
        actorInfo,
        {
          modelId: mid,
          content: cleanTalk.content,
          emotion: cleanTalk.emotion,
          prevContent: cleanTalk.prevContent,
          prevEmotion: cleanTalk.prevEmotion,
          prevTense: cleanTalk.prevTense,
          isListener: false,
          avoidMotion: '',
          fallbackMood: cleanTalk.prevTense ? 'awkward' : 'neutral'
        },
        view
      )
      if (!motion) continue

      if (cleanTalk.clashesAppearIdx !== null) {
        const app = snippets[cleanTalk.clashesAppearIdx]
        if (isRecord(app) && isRecord(app.data)) {
          app.data.motion = ''
        }
      }
      const talkSnippet = snippets[cleanTalk.snippetIndex]
      if (!isRecord(talkSnippet) || !isRecord(talkSnippet.data)) continue
      const tData = talkSnippet.data
      if (Array.isArray(tData.actions) && tData.actions.length > 0) {
        const speakerAct = (tData.actions as JsonRecord[]).find(
          (a) => isRecord(a) && num(a.modelId, mid) === mid
        )
        if (speakerAct) {
          speakerAct.motion = motion
        } else {
          ;(tData.actions as JsonRecord[]).unshift({ at: 0, modelId: mid, motion })
        }
      } else {
        tData.actions = [
          {
            at: 0,
            modelId: mid,
            motion,
            ...(str(tData.facial).trim() ? { facial: str(tData.facial).trim() } : {})
          }
        ]
        if ('facial' in tData) delete tData.facial
      }
      fixedActors += 1
      continue
    }

    const followups = stageFollowupCandidates.get(mid) ?? []
    const spot = followups[0]
    if (spot) {
      const motion = pickVerifiedReplacementMotion(
        actorInfo,
        {
          modelId: mid,
          content: spot.content,
          emotion: spot.emotion,
          prevTense: spot.prevTense,
          isListener: true,
          avoidMotion: '',
          fallbackMood: spot.prevTense ? 'awkward' : 'neutral'
        },
        view
      )
      if (motion) {
        pendingInserts.push({
          afterIdx: spot.insertAfterIndex,
          snippet: {
            type: 'Motion',
            wait: false,
            progressBehavior: 'Now',
            delay: 0.35,
            data: { modelId: mid, motion, facial: '', facialFirst: true }
          }
        })
        fixedActors += 1
      }
    }
  }

  if (pendingInserts.length > 0) {
    pendingInserts.sort((a, b) => b.afterIdx - a.afterIdx)
    for (const item of pendingInserts) {
      snippets.splice(item.afterIdx + 1, 0, item.snippet)
    }
  }

  if (fixedActors > 0) {
    warn(`[Linter] 已为 ${fixedActors} 名零动作在场角色补充贴合语境的身体动作（消除 actor_zero_motions）`)
  }
}

/**
 * 在 validateAndFixStory 末段运行官方不变量修整：
 * 只修能安全确定修整的结构性问题（去机械 0.1s delay、去 <0.4s 入场动作连打、
 * 补转场前 closeWindowOnFinish、闭合未配对的 Flashback/Sepia/Shake/Shader/Camera）。
 */
export function enforceOfficialStoryInvariants(
  story: JsonRecord,
  view: CatalogView,
  rawWarn?: (message: string) => void,
  options: { emotionLabels?: string[] } = {}
): OfficialLintReport {
  const warn = typeof rawWarn === 'function' ? rawWarn : () => {}
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []

  // 0) 清理退场/转场前将被打断的孤立短 Motion，并对齐语境限定动作与听者/对峙表情一致性
  repairActingHygieneInvariants(story, view, warn)

  // 0.5) 统一规范进出场 LayoutClear / LayoutAppear 栅栏与思考/单人切镜顺序
  normalizeLayoutTransitionBarriers(snippets, warn)

  // 1) Talk.delay == 0 >= 85%：去掉 0 < delay <= 0.25 的机械小停顿；若仍低于 85%，按从小到大裁剪多余停顿以保留真正重停顿
  const talks = snippets.filter((s) => s.type === 'Talk')
  if (talks.length >= 3) {
    let zeroCount = talks.filter((s) => num(s.delay, 0) === 0).length
    if (zeroCount / talks.length < 0.85) {
      let cleared = 0
      for (const talk of talks) {
        const d = num(talk.delay, 0)
        if (d > 0 && d <= 0.25) {
          talk.delay = 0
          cleared += 1
          zeroCount += 1
        }
      }
      if (zeroCount / talks.length < 0.85) {
        const minZero = Math.ceil(talks.length * 0.85)
        const remaining = talks
          .filter((t) => num(t.delay, 0) > 0)
          .sort((a, b) => num(a.delay, 0) - num(b.delay, 0))
        for (const talk of remaining) {
          if (zeroCount >= minZero) break
          talk.delay = 0
          cleared += 1
          zeroCount += 1
        }
      }
      if (cleared > 0) {
        warn(`[Linter] 已将 ${cleared} 条多余句前停顿归零，对齐官方 >=85% delay=0 节奏`)
      }
    }
  }

  // 1.5) 清理无实际停顿/转场前的误触 closeWindowOnFinish（避免连续对白间因瞬时 Motion/PlaySe/ChangeBgm 导致对话框闪灭）
  let strippedSpuriousCloses = 0
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    if (str(s.type) !== 'Talk' || !isRecord(s.data) || s.data.closeWindowOnFinish !== true) continue
    let hasRealBreakBeforeNextTalk = false
    let foundNextTalk = false
    for (let j = i + 1; j < snippets.length; j++) {
      const next = snippets[j]
      const nKind = str(next?.type)
      const nData = isRecord(next?.data) ? next.data : {}
      if (
        nKind === 'Wait' &&
        num(nData.duration, 0) >= 300
      ) {
        hasRealBreakBeforeNextTalk = true
        break
      }
      if (
        nKind === 'BlackOut' ||
        nKind === 'SideFade' ||
        nKind === 'SekaiOut' ||
        nKind === 'Telop' ||
        nKind === 'FullScreenText' ||
        nKind === 'LayoutClear' ||
        nKind === 'LayoutAppear' ||
        nKind === 'HideTalk'
      ) {
        hasRealBreakBeforeNextTalk = true
        break
      }
      if (nKind === 'Talk') {
        if (num(next?.delay, 0) >= 0.3) {
          hasRealBreakBeforeNextTalk = true
        }
        foundNextTalk = true
        break
      }
    }
    if (foundNextTalk && !hasRealBreakBeforeNextTalk) {
      delete s.data.closeWindowOnFinish
      strippedSpuriousCloses += 1
    }
  }
  if (strippedSpuriousCloses > 0) {
    warn(`[Linter] 已移除 ${strippedSpuriousCloses} 处瞬时动作/音效前多余的 closeWindowOnFinish`)
  }

  // 2) 去 <0.4s 入场动作连打 & 转场前收窗
  let cursorSec = 0
  let runningEndSec = 0
  let windowOpen = false
  let lastTalkSnippet: JsonRecord | null = null
  const lastAppearMotion = new Map<number, { timeSec: number; motion: string; facial: string }>()
  let dedupedClashes = 0
  let addedCloses = 0

  let flashbackOpen = false
  let sepiaOpen = false
  let shakeScreenActive = false
  let shakeWindowActive = false
  let cameraZoomed = false
  let cameraMoved = false
  const activeShaders = new Set<number>()
  const initBgm = Array.isArray(story.bgm) ? story.bgm : []
  let currentBgmFile =
    initBgm.length > 0 && typeof initBgm[0] === 'string' ? initBgm[0].trim().toLowerCase() : ''
  let dedupedBgm = 0

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const kind = str(snippet.type)
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (
      snippetHasPreFence(
        snippet as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' }
      )
    ) {
      cursorSec = Math.max(cursorSec, runningEndSec)
    }
    const startSec = cursorSec + Math.max(0, num(snippet.delay, 0))
    const durSec = estimateSnippetDurationSec(snippet, windowOpen)
    const endSec = startSec + durSec
    runningEndSec = Math.max(runningEndSec, endSec)

    if (windowOpen && isTransitionOrBreak(snippet) && lastTalkSnippet) {
      const prevData = isRecord(lastTalkSnippet.data) ? lastTalkSnippet.data : {}
      if (prevData.closeWindowOnFinish !== true) {
        prevData.closeWindowOnFinish = true
        lastTalkSnippet.data = prevData
        windowOpen = false
        addedCloses += 1
      }
    }

    if (kind === 'LayoutAppear') {
      const mid = num(data.modelId, -1)
      if (str(data.motion).trim()) {
        lastAppearMotion.set(mid, {
          timeSec: startSec,
          motion: str(data.motion).trim(),
          facial: str(data.facial)
        })
      }
    } else if (kind === 'LayoutClear') {
      const mid = num(data.modelId, -1)
      lastAppearMotion.delete(mid)
      if (activeShaders.has(mid)) {
        const isFirstClear = i === 0 || str(snippets[i - 1]?.type) !== 'LayoutClear'
        snippets.splice(i, 0, {
          type: 'AttachCharacterShader',
          wait: isFirstClear,
          progressBehavior: isFirstClear ? 'WaitFinished' : 'Now',
          delay: 0,
          data: { modelId: mid, shader: 'none' }
        })
        activeShaders.delete(mid)
        i += 1
      }
    } else if (kind === 'Talk') {
      windowOpen = data.closeWindowOnFinish !== true
      lastTalkSnippet = snippet
      const speakerId = num(data.modelId, -1)
      if (str(data.motion).trim()) {
        const appearInfo = lastAppearMotion.get(speakerId)
        if (appearInfo && appearInfo.motion && startSec - appearInfo.timeSec < 0.4 - 1e-6) {
          data.motion = ''
          dedupedClashes += 1
        }
      }
      if (Array.isArray(data.actions)) {
        const filtered: JsonRecord[] = []
        for (const rawAction of data.actions) {
          if (!isRecord(rawAction)) continue
          const aid = num(rawAction.modelId, speakerId)
          const atFrac = num(rawAction.at, 0)
          const actionTime = startSec + atFrac * durSec
          const appearInfo = lastAppearMotion.get(aid)
          if (
            str(rawAction.motion).trim() &&
            appearInfo &&
            appearInfo.motion &&
            actionTime - appearInfo.timeSec < 0.4 - 1e-6
          ) {
            const { motion: _dropped, ...rest } = rawAction
            dedupedClashes += 1
            if (str(rest.facial).trim()) {
              filtered.push(rest)
            }
            continue
          }
          filtered.push(rawAction)
        }
        if (filtered.length > 0) data.actions = filtered
        else delete data.actions
      }
    } else if (kind === 'Motion') {
      const mid = num(data.modelId, -1)
      if (str(data.motion).trim()) {
        const appearInfo = lastAppearMotion.get(mid)
        if (appearInfo && appearInfo.motion && startSec - appearInfo.timeSec < 0.4 - 1e-6) {
          const neededDelay = appearInfo.timeSec + 0.45 - cursorSec
          if (!snippetHasPreFence(snippet as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' }) && neededDelay <= 0.65) {
            snippet.delay = Number(Math.max(num(snippet.delay, 0), neededDelay).toFixed(2))
          } else {
            data.motion = ''
            dedupedClashes += 1
          }
        }
      }
    } else if (kind === 'HideTalk') {
      windowOpen = false
    } else if (kind === 'FlashbackIn') {
      flashbackOpen = true
    } else if (kind === 'FlashbackOut') {
      flashbackOpen = false
    } else if (kind === 'SepiaIn') {
      sepiaOpen = true
    } else if (kind === 'SepiaOut') {
      sepiaOpen = false
    } else if (kind === 'ShakeScreen') {
      if (num(data.duration, 0) >= 10000) shakeScreenActive = true
    } else if (kind === 'StopShakeScreen' || kind === 'StopShake') {
      shakeScreenActive = false
    } else if (kind === 'ShakeWindow') {
      if (num(data.duration, 0) >= 10000) shakeWindowActive = true
    } else if (kind === 'StopShakeWindow') {
      shakeWindowActive = false
    } else if (kind === 'AttachCharacterShader') {
      const mid = num(data.modelId, -1)
      if (str(data.shader) === 'none') activeShaders.delete(mid)
      else activeShaders.add(mid)
    } else if (kind === 'CameraZoom') {
      cameraZoomed = Math.abs(num(data.scale, 1) - 1) > 0.01
    } else if (kind === 'CameraMove') {
      cameraMoved = Math.abs(num(data.x, 0)) > 0.5 || Math.abs(num(data.y, 0)) > 0.5
    } else if (kind === 'ChangeBgm') {
      if (data.stop === true) {
        currentBgmFile = ''
      } else {
        const normalized = str(data.file).trim().toLowerCase()
        if (normalized && normalized === currentBgmFile) {
          snippets.splice(i, 1)
          dedupedBgm += 1
          i -= 1
          continue
        }
        if (normalized) currentBgmFile = normalized
      }
    }
  }

  if (dedupedBgm > 0) {
    warn(`[Linter] 已移除 ${dedupedBgm} 条重复连续的 ChangeBgm 指令`)
  }
  if (dedupedClashes > 0) {
    warn(`[Linter] 已去重 ${dedupedClashes} 处 LayoutAppear 后 <0.4s 的重叠起手动作`)
  }
  if (addedCloses > 0) {
    warn(`[Linter] 已为 ${addedCloses} 处转场/静默拍前的 Talk 补全 closeWindowOnFinish`)
  }

  // 3) 若末尾仍有未关闭的效果/相机，在末尾 BlackOut 之前自动收尾
  const lastBlackOutIndex = (() => {
    for (let idx = snippets.length - 1; idx >= Math.max(0, snippets.length - 4); idx--) {
      if (snippets[idx]?.type === 'BlackOut') return idx
    }
    return snippets.length
  })()

  const closers: JsonRecord[] = []
  if (shakeScreenActive) {
    closers.push({
      type: 'StopShakeScreen',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: {}
    })
  }
  if (shakeWindowActive) {
    closers.push({
      type: 'StopShakeWindow',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: {}
    })
  }
  for (const mid of activeShaders) {
    closers.push({
      type: 'AttachCharacterShader',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { modelId: mid, shader: 'none' }
    })
  }
  if (cameraZoomed) {
    closers.push({
      type: 'CameraZoom',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { scale: 1, duration: 400, ease: 'OutQuad' }
    })
  }
  if (cameraMoved) {
    closers.push({
      type: 'CameraMove',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { x: 0, y: 0, duration: 400, ease: 'OutQuad' }
    })
  }
  if (flashbackOpen) {
    closers.push({
      type: 'FlashbackOut',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { duration: 100 }
    })
  }
  if (sepiaOpen) {
    closers.push({
      type: 'SepiaOut',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { duration: 100 }
    })
  }
  if (closers.length > 0) {
    snippets.splice(lastBlackOutIndex, 0, ...closers)
    warn(`[Linter] 已在片尾自动补全 ${closers.length} 条未闭合特效/镜头复位指令`)
  }

  // 3.5) 同步哭戏/悲伤对峙段落的 emotion 标签，防止掉回「平静」；若 emotion 发生变化则再同步一次表演兼容性
  const syncedEmotions = syncTalkEmotionContinuity(snippets, {
    models: Array.isArray(story.models) ? (story.models as JsonRecord[]) : undefined,
    view,
    allowedLabels: options.emotionLabels,
    warn
  })
  if (syncedEmotions > 0) {
    repairActingHygieneInvariants(story, view, warn)
  }

  // 3.6) 确保长场次（>=6 句 Talk）中每位出场角色至少拥有 1 个非入场的身体动作（消除 actor_zero_motions）
  ensureEveryActorHasBodyMotion(story, view, warn)

  // 后置清洗 Irodori 逐句语音导演字段（caption 去身份词、语速钳制、emoji 预算、specialScene <= 15%）
  {
    const talkDatas: JsonRecord[] = []
    for (const s of snippets) {
      if (!isRecord(s) || str(s.type) !== 'Talk' || !isRecord(s.data)) continue
      const data = s.data
      talkDatas.push(data)
      if (typeof data.content === 'string' && hasZeroWidthChars(data.content)) {
        data.content = stripZeroWidthChars(data.content)
      }
      if (typeof data.ttsCaption === 'string' && data.ttsCaption) {
        data.ttsCaption = sanitizeIrodoriCaption(data.ttsCaption)
      }
      if (typeof data.ttsText === 'string' && data.ttsText) {
        data.ttsText = enforceIrodoriEmojiBudget(stripZeroWidthChars(data.ttsText), 2)
      }
      if (typeof data.ttsSpeed === 'number' && Number.isFinite(data.ttsSpeed)) {
        const special = data.ttsSpecialScene === true
        data.ttsSpeed = Number(
          Math.min(special ? 1.18 : 1.08, Math.max(special ? 0.85 : 0.92, data.ttsSpeed)).toFixed(2)
        )
      }
    }
    const maxSpecial = Math.floor(talkDatas.length * 0.15)
    let keptSpecial = 0
    for (const data of talkDatas) {
      if (data.ttsSpecialScene !== true) continue
      if (keptSpecial < maxSpecial) {
        keptSpecial += 1
      } else {
        delete data.ttsSpecialScene
        if (typeof data.ttsSpeed === 'number' && Number.isFinite(data.ttsSpeed)) {
          data.ttsSpeed = Number(Math.min(1.08, Math.max(0.92, data.ttsSpeed)).toFixed(2))
        }
      }
    }
  }

  const report = lintOfficialStory(story, view)
  for (const issue of report.issues) {
    warn(`[Linter] ${issue}`)
  }
  return report
}

export interface ActingFidelityDiagnostic {
  snippetIndex: number
  lineNumber: number
  modelId: number
  listenerModelId?: number
  speaker: string
  content: string
  emotion: string
  facial: string
  motion: string
  inferredMood: DramaticContextMood
  field: 'facial' | 'motion' | 'repetition' | 'staging' | 'dialogue'
  code: string
  severity: 'high' | 'medium'
  message: string
  recommendedFacials: string[]
  recommendedMotions: string[]
}

export interface ActingFidelityReport {
  passed: boolean
  score: number
  talkCount: number
  diagnostics: ActingFidelityDiagnostic[]
  zeroMotionModelIds: number[]
  repeatedFacialRunCount: number
  facialMismatchCount: number
  motionMismatchCount: number
  simultaneousCollisionCount: number
  stageDirectionLeakCount: number
  listenerFrozenCount: number
  staggeredMidlineMotionCount: number
  excessiveSlidingCount: number
  duplicateBgmCount: number
  zeroWidthCharCount: number
  officialReport: OfficialLintReport
}

function findSurroundingTalkContext(
  snippets: JsonRecord[],
  index: number,
  modelId: number,
  preferNext: boolean
): { content: string; emotion: string; modelId: number } | null {
  let prevAny: { content: string; emotion: string; modelId: number } | null = null
  let prevSame: { content: string; emotion: string; modelId: number } | null = null
  for (let j = index - 1; j >= Math.max(0, index - 3); j--) {
    const s = snippets[j]
    if (str(s?.type) !== 'Talk' || !isRecord(s.data)) continue
    const entry = {
      content: str(s.data.content),
      emotion: str(s.data.emotion),
      modelId: num(s.data.modelId, -1)
    }
    if (!prevAny) prevAny = entry
    if (entry.modelId === modelId && !prevSame) prevSame = entry
  }

  let nextAny: { content: string; emotion: string; modelId: number } | null = null
  let nextSame: { content: string; emotion: string; modelId: number } | null = null
  for (let j = index + 1; j <= Math.min(snippets.length - 1, index + 4); j++) {
    const s = snippets[j]
    if (str(s?.type) !== 'Talk' || !isRecord(s.data)) continue
    const entry = {
      content: str(s.data.content),
      emotion: str(s.data.emotion),
      modelId: num(s.data.modelId, -1)
    }
    if (!nextAny) nextAny = entry
    if (entry.modelId === modelId && !nextSame) nextSame = entry
  }

  if (preferNext) {
    return nextSame ?? nextAny ?? prevSame ?? prevAny
  }
  return prevSame ?? nextSame ?? prevAny ?? nextAny
}

/**
 * 逐句诊断整部剧本的演技贴合度与官方剧本规范：
 * - 表情（facial）与动作（motion）是否贴合台词剧情、情绪、听者视角及角色气质
 * - 是否连续多句僵硬重复同一表情或动作
 * - 同句内是否出现双人同瞬动作碰撞、在场角色全程零动作、spoken 括号动作泄露
 * - 为每条诊断附带可直接替换的 recommendedFacials / recommendedMotions
 */
export function auditStoryActingAndFidelity(
  story: StoryData | JsonRecord,
  view?: CatalogView,
  options: { restrainedNames?: string[] } = {}
): ActingFidelityReport {
  const officialReport = lintOfficialStory(story, view)
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
  const models = Array.isArray(story.models) ? (story.models as JsonRecord[]) : []
  const extraRestrained = new Set(
    (options.restrainedNames ?? []).map((n) => n.trim()).filter(Boolean)
  )

  const modelMeta = new Map<
    number,
    { path?: string; name: string; facials: string[]; motions: string[]; restrained: boolean }
  >()
  for (const m of models) {
    const id = num(m.id, -1)
    if (id === -1) continue
    const catalogModel = view?.modelById(id)
    const modelPath = str(m.model) || catalogModel?.path
    const name = catalogModel ? view!.shortName(catalogModel) : str(m.name, `model${id}`)
    const facials = catalogModel ? [...catalogModel.facials] : []
    const motions = catalogModel ? [...catalogModel.motions] : []
    const restrained =
      extraRestrained.has(name) || characterActingProfile(`${name} ${modelPath ?? ''}`).restrained
    modelMeta.set(id, { path: modelPath, name, facials, motions, restrained })
  }

  const diagnostics: ActingFidelityDiagnostic[] = []
  const bodyMotionCounts = new Map<number, number>()
  for (const id of modelMeta.keys()) bodyMotionCounts.set(id, 0)

  interface ActorTrackState {
    prevFacial: string
    sameFacialCount: number
    prevMotion: string
    sameMotionCount: number
  }
  const actorTracking = new Map<number, ActorTrackState>()
  const getTracker = (id: number): ActorTrackState => {
    let t = actorTracking.get(id)
    if (!t) {
      t = { prevFacial: '', sameFacialCount: 0, prevMotion: '', sameMotionCount: 0 }
      actorTracking.set(id, t)
    }
    return t
  }

  let talkCount = 0
  let prevContent = ''
  let prevEmotion = ''
  const tenseTracker: SceneTenseTracker = { tense: false, calmRun: 0 }
  const actorState = new Map<number, ActorTenseState>()
  let repeatedFacialRunCount = 0
  let facialMismatchCount = 0
  let motionMismatchCount = 0
  let simultaneousCollisionCount = 0
  let stageDirectionLeakCount = 0
  let listenerFrozenCount = 0
  let staggeredMidlineMotionCount = 0
  let excessiveSlidingCount = 0
  let duplicateBgmCount = 0
  let zeroWidthCharCount = 0

  const onStage = new Set<number>()
  interface ListenerTrackState {
    silentLinesSinceUpdate: number
    consecutiveOtherSpeakerLines: number
    lastOtherSpeakerId: number
  }
  const listenerState = new Map<number, ListenerTrackState>()
  const resetListenerState = (id: number): void => {
    listenerState.set(id, {
      silentLinesSinceUpdate: 0,
      consecutiveOtherSpeakerLines: 0,
      lastOtherSpeakerId: -1
    })
  }
  const rawStoryBgm = (story as JsonRecord).bgm
  const initialBgmList = Array.isArray(rawStoryBgm) ? rawStoryBgm : []
  let currentBgmFile =
    initialBgmList.length > 0 && typeof initialBgmList[0] === 'string'
      ? initialBgmList[0].trim().toLowerCase()
      : ''
  const talkRecordsForComedy = collectTalkEmotionRecords(
    snippets,
    Array.isArray(story.models) ? (story.models as JsonRecord[]) : undefined,
    view
  )
  const comedyProbeLines = talkRecordsForComedy.map((rec) => ({
    content: rec.content,
    emotion: rec.emotion,
    sceneId: String(rec.sceneId)
  }))
  const talkPosBySnippet = new Map<number, number>()
  talkRecordsForComedy.forEach((rec, pos) => talkPosBySnippet.set(rec.snippetIndex, pos))

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const kind = str(snippet.type)
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (isFadeOutOrClearTransition(snippet) || kind === 'ChangeBackgroundImage') {
      tenseTracker.tense = false
      tenseTracker.calmRun = 0
      prevContent = ''
      prevEmotion = ''
      actorState.clear()
      continue
    }

    if (kind === 'ChangeBgm') {
      if (data.stop === true) {
        currentBgmFile = ''
      } else {
        const bgmFile = str(data.file).trim()
        const normalized = bgmFile.toLowerCase()
        if (normalized) {
          if (normalized === currentBgmFile) {
            duplicateBgmCount += 1
            diagnostics.push({
              snippetIndex: i,
              lineNumber: talkCount,
              modelId: -1,
              speaker: '',
              content: '',
              emotion: '',
              facial: '',
              motion: '',
              inferredMood: 'neutral',
              field: 'staging',
              code: 'duplicate_bgm',
              severity: 'medium',
              message: `snippets[${i}] 连续重复播放相同 BGM（${bgmFile}），请移除冗余 ChangeBgm`,
              recommendedFacials: [],
              recommendedMotions: []
            })
          } else {
            currentBgmFile = normalized
          }
        }
      }
      continue
    }

    if (kind === 'LayoutClear') {
      const mid = num(data.modelId, -1)
      if (mid !== -1) {
        onStage.delete(mid)
        resetListenerState(mid)
        const tracker = getTracker(mid)
        tracker.prevFacial = ''
        tracker.sameFacialCount = 0
        tracker.prevMotion = ''
        tracker.sameMotionCount = 0
      }
      continue
    }

    if (kind === 'LayoutAppear' || kind === 'Move') {
      const mid = num(data.modelId, -1)
      const motion = str(data.motion).trim()
      const facial = str(data.facial).trim()
      const meta = modelMeta.get(mid)
      if (kind === 'LayoutAppear' && mid !== -1) {
        onStage.add(mid)
        resetListenerState(mid)
      } else if (kind === 'Move' && mid !== -1 && (motion || facial)) {
        resetListenerState(mid)
      }
      if (kind === 'Move' && motion) {
        bodyMotionCounts.set(mid, (bodyMotionCounts.get(mid) ?? 0) + 1)
      }
      if (motion && isSpecialOrStandingMotion(motion)) {
        const evalRes = evaluateActingLineMatch({
          motion,
          facials: meta?.facials ?? [],
          motions: meta?.motions ?? [],
          modelPath: meta?.path,
          content: '',
          isEntryExit: true,
          restrainedRole: meta?.restrained
        })
        motionMismatchCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkCount,
          modelId: mid,
          speaker: meta?.name ?? `model${mid}`,
          content: '',
          emotion: '',
          facial,
          motion,
          inferredMood: 'entry_exit',
          field: 'motion',
          code: 'standing_or_special_entry_motion',
          severity: 'medium',
          message: `${kind} 不宜使用静态站姿或特殊清场动作 ${motion}`,
          recommendedFacials: evalRes.recommendedFacials,
          recommendedMotions: evalRes.recommendedMotions
        })
      }
      if (facial) {
        const surrounding = findSurroundingTalkContext(snippets, i, mid, kind === 'LayoutAppear')
        if (surrounding) {
          const fc = isFacialCompatibleWithLine({
            facial,
            modelPath: meta?.path,
            emotion: surrounding.emotion,
            content: surrounding.content,
            prevTense: tenseTracker.tense,
            isMonologue: false,
            isListener: false,
            restrainedRole: meta?.restrained
          })
          if (!fc.ok) {
            const rec = recommendActingForLine({
              facials: meta?.facials ?? [],
              motions: meta?.motions ?? [],
              modelPath: meta?.path,
              content: surrounding.content,
              emotion: surrounding.emotion,
              prevTense: tenseTracker.tense,
              restrainedRole: meta?.restrained,
              prevFacial: getTracker(mid).prevFacial
            })
            facialMismatchCount += 1
            diagnostics.push({
              snippetIndex: i,
              lineNumber: talkCount,
              modelId: mid,
              speaker: meta?.name ?? `model${mid}`,
              content: surrounding.content,
              emotion: surrounding.emotion,
              facial,
              motion,
              inferredMood: rec.mood,
              field: 'facial',
              code: fc.reason ?? 'stage_facial_mood_mismatch',
              severity: 'high',
              message: `${kind} 表情 ${facial} 与前后「${rec.mood}」情绪语境冲突`,
              recommendedFacials: rec.facials,
              recommendedMotions: rec.motions
            })
          }
        }
      }
      const tracker = getTracker(mid)
      if (kind === 'LayoutAppear') {
        tracker.prevFacial = facial
        tracker.sameFacialCount = facial ? 1 : 0
        tracker.prevMotion = motion
        tracker.sameMotionCount = motion ? 1 : 0
      } else {
        if (facial) {
          tracker.sameFacialCount = tracker.prevFacial === facial ? tracker.sameFacialCount + 1 : 1
          tracker.prevFacial = facial
        }
        if (motion) {
          tracker.sameMotionCount = tracker.prevMotion === motion ? tracker.sameMotionCount + 1 : 1
          tracker.prevMotion = motion
        }
      }
      if (facial) {
        updateActorStateOnTalkOrStage(actorState, mid, meta?.path, facial)
      }
      continue
    }

    if (kind === 'Motion') {
      const mid = num(data.modelId, -1)
      const actions = Array.isArray(data.actions) ? (data.actions as JsonRecord[]) : []
      if (str(data.motion).trim()) {
        bodyMotionCounts.set(mid, (bodyMotionCounts.get(mid) ?? 0) + 1)
        if (mid !== -1) resetListenerState(mid)
      } else if (str(data.facial).trim() && mid !== -1) {
        resetListenerState(mid)
      }
      if (str(data.facial).trim() && mid !== -1) {
        updateActorStateOnTalkOrStage(actorState, mid, modelMeta.get(mid)?.path, str(data.facial).trim())
      }
      for (const act of actions) {
        if (!isRecord(act)) continue
        const aid = num(act.modelId, mid)
        if (str(act.motion).trim()) {
          bodyMotionCounts.set(aid, (bodyMotionCounts.get(aid) ?? 0) + 1)
        }
        if ((str(act.motion).trim() || str(act.facial).trim()) && aid !== -1) {
          resetListenerState(aid)
        }
        if (str(act.facial).trim() && aid !== -1) {
          updateActorStateOnTalkOrStage(actorState, aid, modelMeta.get(aid)?.path, str(act.facial).trim())
        }
      }
      continue
    }

    if (kind !== 'Talk') continue
    talkCount += 1
    const speakerId = num(data.modelId, -1)
    const speakerName = str(data.speaker, modelMeta.get(speakerId)?.name ?? '')
    const content = str(data.content)
    const emotion = str(data.emotion)
    const ttsText = str(data.ttsText)
    const talkPos = talkPosBySnippet.get(i) ?? -1
    const cheerfulScene =
      talkPos >= 0 ? isCheerfulComedyContext(comedyProbeLines, talkPos) : false
    const effectivePrevTense = tenseTracker.tense && !cheerfulScene

    if (hasZeroWidthChars(content)) {
      zeroWidthCharCount += 1
      diagnostics.push({
        snippetIndex: i,
        lineNumber: talkCount,
        modelId: speakerId,
        speaker: speakerName,
        content,
        emotion,
        facial: '',
        motion: '',
        inferredMood: 'neutral',
        field: 'dialogue',
        code: 'content_zero_width_leak',
        severity: 'medium',
        message: '台词 content 混入了零宽字符（如 \\u200b/\\ufeff），请清理干净',
        recommendedFacials: [],
        recommendedMotions: []
      })
    }
    if (hasZeroWidthChars(ttsText)) {
      zeroWidthCharCount += 1
      diagnostics.push({
        snippetIndex: i,
        lineNumber: talkCount,
        modelId: speakerId,
        speaker: speakerName,
        content,
        emotion,
        facial: '',
        motion: '',
        inferredMood: 'neutral',
        field: 'dialogue',
        code: 'tts_zero_width_leak',
        severity: 'medium',
        message: '台词 ttsText 混入了零宽字符（如 \\u200b/\\ufeff），请清理（保留 Irodori Emoji）',
        recommendedFacials: [],
        recommendedMotions: []
      })
    }

    if (hasSpokenStageDirectionLeak(content)) {
      stageDirectionLeakCount += 1
      diagnostics.push({
        snippetIndex: i,
        lineNumber: talkCount,
        modelId: speakerId,
        speaker: speakerName,
        content,
        emotion,
        facial: '',
        motion: '',
        inferredMood: 'neutral',
        field: 'dialogue',
        code: 'stage_direction_leak',
        severity: 'high',
        message:
          '台词文本夹带了舞台动作括号或第三人称叙述，应删去动作描写，改由 motion/facial 表现',
        recommendedFacials: [],
        recommendedMotions: []
      })
    }

    const actions: Array<{ at: number; modelId: number; motion: string; facial: string }> = []
    if (Array.isArray(data.actions)) {
      for (const rawAct of data.actions) {
        if (!isRecord(rawAct)) continue
        actions.push({
          at: num(rawAct.at, 0),
          modelId: num(rawAct.modelId, speakerId),
          motion: str(rawAct.motion).trim(),
          facial: str(rawAct.facial).trim()
        })
      }
    }
    if (actions.length === 0 && (str(data.motion).trim() || str(data.facial).trim())) {
      actions.push({
        at: 0,
        modelId: speakerId,
        motion: str(data.motion).trim(),
        facial: str(data.facial).trim()
      })
    }

    // 检查同句双人同瞬身体动作碰撞
    for (let a = 0; a < actions.length; a++) {
      for (let b = a + 1; b < actions.length; b++) {
        if (
          actions[a].modelId !== actions[b].modelId &&
          actions[a].motion &&
          actions[b].motion &&
          Math.abs(actions[a].at - actions[b].at) < 0.25 - 1e-6
        ) {
          simultaneousCollisionCount += 1
          diagnostics.push({
            snippetIndex: i,
            lineNumber: talkCount,
            modelId: actions[b].modelId,
            speaker: speakerName,
            content,
            emotion,
            facial: actions[b].facial,
            motion: actions[b].motion,
            inferredMood: 'neutral',
            field: 'staging',
            code: 'simultaneous_dual_motion',
            severity: 'high',
            message: `第 ${talkCount} 句内说话者与听者在相近时刻同时触发身体动作，易造成舞台撞拍`,
            recommendedFacials: [],
            recommendedMotions: []
          })
        }
      }
    }

    for (const act of actions) {
      if (act.modelId === -1) continue
      const isListener = act.modelId !== speakerId
      if (isListener && act.at > 0.01 && act.motion) {
        staggeredMidlineMotionCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkCount,
          modelId: act.modelId,
          listenerModelId: act.modelId,
          speaker: `${modelMeta.get(act.modelId)?.name ?? act.modelId}(听者)`,
          content,
          emotion,
          facial: act.facial,
          motion: act.motion,
          inferredMood: 'attentive_listen',
          field: 'staging',
          code: 'staggered_midline_motion',
          severity: 'high',
          message: `第 ${talkCount} 句在句中 at=${act.at} 触发听者身体动作 ${act.motion}，易造成突兀错峰弹窗；官方 PJSK 听者反应请改为句首 at=0 纯切 facial 或独立 Motion 节拍`,
          recommendedFacials: [],
          recommendedMotions: []
        })
      }
      if (act.motion) {
        bodyMotionCounts.set(act.modelId, (bodyMotionCounts.get(act.modelId) ?? 0) + 1)
      }
      const meta = modelMeta.get(act.modelId)
      const tracker = getTracker(act.modelId)
      const nextSameFacial =
        act.facial && act.facial === tracker.prevFacial
          ? tracker.sameFacialCount + 1
          : act.facial
            ? 1
            : 0
      const nextSameMotion =
        act.motion && act.motion === tracker.prevMotion
          ? tracker.sameMotionCount + 1
          : act.motion
            ? 1
            : 0

      const evalRes = evaluateActingLineMatch({
        facial: act.facial,
        motion: act.motion,
        facials: meta?.facials ?? [],
        motions: meta?.motions ?? [],
        modelPath: meta?.path,
        content,
        emotion,
        prevContent,
        prevEmotion,
        prevTense: effectivePrevTense,
        isListener,
        restrainedRole: meta?.restrained,
        prevFacial: tracker.prevFacial,
        prevMotion: tracker.prevMotion,
        consecutiveSameFacialCount: nextSameFacial,
        consecutiveSameMotionCount: nextSameMotion,
        cheerfulScene
      })

      let flaggedListenerSmile = false
      if (isListener && act.facial) {
        const lState = actorState.get(act.modelId) ?? null
        const isLockedTenseListener =
          !(cheerfulScene && emotion === '开心') &&
          (lState === 'angry' ||
            lState === 'sad' ||
            lState === 'cry' ||
            lState === 'serious' ||
            (lState === 'trouble' && effectivePrevTense))
        if (
          isLockedTenseListener &&
          lState &&
          (isPositiveOnlyFacial(act.facial, meta?.path) ||
            (lState === 'angry' && isSmileLikeFacial(act.facial, meta?.path)))
        ) {
          flaggedListenerSmile = true
          facialMismatchCount += 1
          const listenerFallbacks =
            meta?.facials.length
              ? [pickListenerFallbackFacial(meta.facials, lState, meta.path, meta.restrained)]
              : []
          diagnostics.push({
            snippetIndex: i,
            lineNumber: talkCount,
            modelId: act.modelId,
            listenerModelId: act.modelId,
            speaker: `${meta?.name ?? act.modelId}(听者)`,
            content,
            emotion,
            facial: act.facial,
            motion: act.motion,
            inferredMood: lState === 'angry' || lState === 'serious' ? 'angry_frustration' : 'sad_regret',
            field: 'facial',
            code: 'listener_forced_smile',
            severity: 'high',
            message: `听者 ${meta?.name ?? act.modelId} 前序处于 ${lState} 状态且尚未和好，禁止突然切为笑脸 ${act.facial}`,
            recommendedFacials: listenerFallbacks.filter(Boolean),
            recommendedMotions: []
          })
        }
      }

      for (const issue of evalRes.issues) {
        if (flaggedListenerSmile && issue.field === 'facial') continue
        if (issue.field === 'facial') facialMismatchCount += 1
        else if (issue.field === 'motion') motionMismatchCount += 1
        else if (issue.field === 'repetition') repeatedFacialRunCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkCount,
          modelId: act.modelId,
          speaker: isListener ? `${meta?.name ?? act.modelId}(听者)` : speakerName,
          content,
          emotion,
          facial: act.facial,
          motion: act.motion,
          inferredMood: evalRes.inferredMood,
          field: issue.field,
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          recommendedFacials: evalRes.recommendedFacials,
          recommendedMotions: evalRes.recommendedMotions
        })
      }

      if (act.facial) {
        tracker.prevFacial = act.facial
        tracker.sameFacialCount = nextSameFacial
      }
      if (act.motion) {
        tracker.prevMotion = act.motion
        tracker.sameMotionCount = nextSameMotion
      }
    }

    // 审计在场听者是否长时间僵立不动（listener_frozen）
    // 官方 PJSK 节奏下说话者连续 2~3 句是常态，且纯内心独白（……）听者听不见，不计入听者僵直
    const isInnerMonologue = /^[（(][^（）()]+[）)]$/.test(content.trim())
    const updatedModelIds = new Set<number>()
    for (const act of actions) {
      if (act.modelId !== -1 && (act.facial || act.motion)) {
        updatedModelIds.add(act.modelId)
      }
    }
    if (speakerId !== -1) {
      resetListenerState(speakerId)
    }
    for (const listenerId of onStage) {
      if (listenerId === speakerId || listenerId === -1) continue
      if (updatedModelIds.has(listenerId)) {
        resetListenerState(listenerId)
        continue
      }
      if (isInnerMonologue) continue
      const st = listenerState.get(listenerId) ?? {
        silentLinesSinceUpdate: 0,
        consecutiveOtherSpeakerLines: 0,
        lastOtherSpeakerId: -1
      }
      st.silentLinesSinceUpdate += 1
      if (speakerId !== -1) {
        if (st.lastOtherSpeakerId === speakerId) {
          st.consecutiveOtherSpeakerLines += 1
        } else {
          st.lastOtherSpeakerId = speakerId
          st.consecutiveOtherSpeakerLines = 1
        }
      }
      listenerState.set(listenerId, st)

      if (st.consecutiveOtherSpeakerLines >= 4 || st.silentLinesSinceUpdate >= 5) {
        listenerFrozenCount += 1
        const lMeta = modelMeta.get(listenerId)
        const lTracker = getTracker(listenerId)
        const lRec = recommendActingForLine({
          facials: lMeta?.facials ?? [],
          motions: lMeta?.motions ?? [],
          modelPath: lMeta?.path,
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense: tenseTracker.tense,
          isListener: true,
          restrainedRole: lMeta?.restrained,
          prevFacial: lTracker.prevFacial,
          prevMotion: lTracker.prevMotion
        })
        const frozenSpan = Math.max(st.consecutiveOtherSpeakerLines, st.silentLinesSinceUpdate)
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkCount,
          modelId: listenerId,
          listenerModelId: listenerId,
          speaker: `${lMeta?.name ?? `model${listenerId}`}(听者)`,
          content,
          emotion,
          facial: '',
          motion: '',
          inferredMood: lRec.mood,
          field: 'staging',
          code: 'listener_frozen',
          severity: frozenSpan >= 6 ? 'high' : 'medium',
          message: `在场听者 ${lMeta?.name ?? listenerId} 已连续 ${frozenSpan} 句无表情变化，建议在合适台词句首（at: 0）补充纯 facial 表情微调，或在重大情绪转折处插入独立 Motion 节拍（避免句中错峰弹身体动作）`,
          recommendedFacials: lRec.facials,
          recommendedMotions: lRec.motions
        })
        st.silentLinesSinceUpdate = 0
        st.consecutiveOtherSpeakerLines = 0
      }
    }

    const effectiveSpeakerFacial = getSpeakerFacialFromTalk(data, speakerId)
    updateActorStateOnTalkOrStage(
      actorState,
      speakerId,
      modelMeta.get(speakerId)?.path,
      effectiveSpeakerFacial,
      emotion,
      content
    )
    for (const act of actions) {
      if (act.modelId !== -1 && act.modelId !== speakerId && act.facial) {
        updateActorStateOnTalkOrStage(actorState, act.modelId, modelMeta.get(act.modelId)?.path, act.facial)
      }
    }
    prevContent = content
    prevEmotion = emotion
    updateSceneTenseAfterTalk(tenseTracker, content, emotion, { cheerfulScene })
  }

  const zeroMotionModelIds: number[] = []
  if (talkCount >= 6) {
    for (const [mid, count] of bodyMotionCounts) {
      if (count === 0) {
        zeroMotionModelIds.push(mid)
        const meta = modelMeta.get(mid)
        const rec = evaluateActingLineMatch({
          facials: meta?.facials ?? [],
          motions: meta?.motions ?? [],
          modelPath: meta?.path,
          content: '',
          restrainedRole: meta?.restrained
        })
        diagnostics.push({
          snippetIndex: Math.max(0, snippets.length - 1),
          lineNumber: talkCount,
          modelId: mid,
          speaker: meta?.name ?? `model${mid}`,
          content: '',
          emotion: '',
          facial: '',
          motion: '',
          inferredMood: 'neutral',
          field: 'motion',
          code: 'actor_zero_motions',
          severity: 'high',
          message: `在场角色 ${meta?.name ?? mid} 全场共有 0 个身体动作，站桩过僵，请在承接句或独立 Motion 节拍补充动作`,
          recommendedFacials: rec.recommendedFacials,
          recommendedMotions: rec.recommendedMotions
        })
      }
    }
  }

  if (officialReport.metrics.staggeredListenerActionCount >= 4) {
    diagnostics.push({
      snippetIndex: 0,
      lineNumber: 0,
      modelId: -1,
      speaker: '',
      content: '',
      emotion: '',
      facial: '',
      motion: '',
      inferredMood: 'neutral',
      field: 'staging',
      code: 'excessive_staggered_listener',
      severity: 'high',
      message: `全片存在 ${officialReport.metrics.staggeredListenerActionCount} 处句中错峰听者动作（at > 0），错峰过于密集；请对齐官方 PJSK 节奏，听者反应改为句首 at=0 纯切 facial 或少量独立 Motion 节拍`,
      recommendedFacials: [],
      recommendedMotions: []
    })
  }

  if (
    officialReport.metrics.slideEntryExitCount >= 2 &&
    (officialReport.metrics.inPlaceAppearShare < 0.6 ||
      officialReport.metrics.inPlaceClearShare < 0.6)
  ) {
    excessiveSlidingCount = officialReport.metrics.slideEntryExitCount
    diagnostics.push({
      snippetIndex: 0,
      lineNumber: 0,
      modelId: -1,
      speaker: '',
      content: '',
      emotion: '',
      facial: '',
      motion: '',
      inferredMood: 'neutral',
      field: 'staging',
      code: 'excessive_slide_entry_exit',
      severity: 'medium',
      message: `存在 ${excessiveSlidingCount} 处画外滑入/滑出，过于依赖移动进出场；官方 PJSK（如 event_145_08）默认采用槽位原地淡入淡出（from.side === to.side, offset: 0）`,
      recommendedFacials: [],
      recommendedMotions: []
    })
  }

  let penalty = officialReport.issues.length * 10
  for (const d of diagnostics) {
    penalty += d.severity === 'high' ? 12 : 5
  }
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const hasHigh = diagnostics.some((d) => d.severity === 'high')

  return {
    passed: officialReport.passed && !hasHigh && zeroMotionModelIds.length === 0,
    score,
    talkCount,
    diagnostics,
    zeroMotionModelIds,
    repeatedFacialRunCount,
    facialMismatchCount,
    motionMismatchCount,
    simultaneousCollisionCount,
    stageDirectionLeakCount,
    listenerFrozenCount,
    staggeredMidlineMotionCount,
    excessiveSlidingCount,
    duplicateBgmCount,
    zeroWidthCharCount,
    officialReport
  }
}
