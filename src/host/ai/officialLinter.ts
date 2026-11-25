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
import { enforceIrodoriEmojiBudget, sanitizeIrodoriCaption } from '../../common/tts/irodori'
import { hasSpokenStageDirectionLeak } from './dialogueLinter'
import {
  evaluateActingLineMatch,
  isFacialCompatibleWithLine,
  isSpecialOrStandingMotion,
  recommendActingForLine,
  type DramaticContextMood
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
    case 'Motion':
      return Array.isArray(data.actions) ? Math.max(0.1, num(data.duration, 2)) : 0
    case 'Talk':
      return estimateTalkDurationSec(data, windowOpen)
    default:
      return 0
  }
}

function isTransitionOrBreak(snippet: JsonRecord): boolean {
  const kind = str(snippet.type)
  const data = isRecord(snippet.data) ? snippet.data : {}
  if (kind === 'BlackOut' || kind === 'SekaiOut' || kind === 'Telop') return true
  if (kind === 'SideFade' && str(data.mode).toLowerCase() === 'out') return true
  if (kind === 'Move') return true
  if (kind === 'Motion') return true
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
  const lastAppearMotion = new Map<number, { timeSec: number; motion: string; facial: string }>()

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const kind = str(snippet.type)
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (isSlow100Slide(snippet)) {
      slow100SlideCount += 1
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
      if (data.mode === 'Three') {
        stageViolationCount += 1
        issues.push(`snippets[${i}] 禁止使用 ThreeMode（官方剧集全为 Normal <=2 人模式）`)
      }
    } else if (kind === 'LayoutAppear') {
      appearCount += 1
      const from = isRecord(data.from) ? data.from : {}
      const to = isRecord(data.to) ? data.to : {}
      if (
        str(from.side, 'Center') === str(to.side, 'Center') &&
        num(from.offset, 0) === num(to.offset, 0)
      ) {
        inPlaceAppearCount += 1
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
          if (str(action.motion).trim()) {
            checkActionTime(aid, str(action.motion).trim(), num(action.at, 0))
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
  if (talkCount >= 15 && seCount === 0) {
    warnings.push(
      '长段剧情全程未配置任何 Sound/PlaySe 音效，建议在脚步/开门/提示音等物理节拍处适量点缀'
    )
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
      inPlaceAppearShare:
        appearCount > 0 ? Number((inPlaceAppearCount / appearCount).toFixed(3)) : 1,
      stageViolationCount,
      duplicateBgmCount
    }
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
  warn: (message: string) => void
): OfficialLintReport {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []

  // 1) Talk.delay == 0 >= 85%：去掉 0 < delay <= 0.25 的机械小停顿，保留 >= 0.5s 刻意留白
  const talks = snippets.filter((s) => s.type === 'Talk')
  if (talks.length >= 3) {
    const zeroCount = talks.filter((s) => num(s.delay, 0) === 0).length
    if (zeroCount / talks.length < 0.85) {
      let cleared = 0
      for (const talk of talks) {
        const d = num(talk.delay, 0)
        if (d > 0 && d <= 0.25) {
          talk.delay = 0
          cleared += 1
        }
      }
      if (cleared > 0) {
        warn(`[Linter] 已将 ${cleared} 条机械微停顿 (<=0.25s) 归零，对齐官方 93% delay=0 节奏`)
      }
    }
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
        snippets.splice(i, 0, {
          type: 'AttachCharacterShader',
          wait: false,
          progressBehavior: 'Now',
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
  let prevTense = false
  let repeatedFacialRunCount = 0
  let facialMismatchCount = 0
  let motionMismatchCount = 0
  let simultaneousCollisionCount = 0
  let stageDirectionLeakCount = 0
  let listenerFrozenCount = 0
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

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const kind = str(snippet.type)
    const data = isRecord(snippet.data) ? snippet.data : {}

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
        listenerState.delete(mid)
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
            prevTense,
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
              prevTense,
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
      if (facial) getTracker(mid).prevFacial = facial
      if (motion) getTracker(mid).prevMotion = motion
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
      for (const act of actions) {
        if (!isRecord(act)) continue
        const aid = num(act.modelId, mid)
        if (str(act.motion).trim()) {
          bodyMotionCounts.set(aid, (bodyMotionCounts.get(aid) ?? 0) + 1)
        }
        if ((str(act.motion).trim() || str(act.facial).trim()) && aid !== -1) {
          resetListenerState(aid)
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
        prevTense,
        isListener,
        restrainedRole: meta?.restrained,
        prevFacial: tracker.prevFacial,
        prevMotion: tracker.prevMotion,
        consecutiveSameFacialCount: nextSameFacial,
        consecutiveSameMotionCount: nextSameMotion
      })

      for (const issue of evalRes.issues) {
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

      if (st.consecutiveOtherSpeakerLines >= 2 || st.silentLinesSinceUpdate >= 3) {
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
          prevTense,
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
          severity: 'high',
          message: `在场听者 ${lMeta?.name ?? listenerId} 已连续 ${frozenSpan} 句无任何表情/动作反应，请补充听者反应（可仅切 facial，或将听者身体动作错拍放在 at: 0.5..0.85，避免与说话者 at: 0 撞拍）`,
          recommendedFacials: lRec.facials,
          recommendedMotions: lRec.motions
        })
        st.silentLinesSinceUpdate = 0
        st.consecutiveOtherSpeakerLines = 0
      }
    }

    prevContent = content
    prevEmotion = emotion
    prevTense = emotion === '生气' || emotion === '伤心' || emotion === '害怕'
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
    duplicateBgmCount,
    zeroWidthCharCount,
    officialReport
  }
}
