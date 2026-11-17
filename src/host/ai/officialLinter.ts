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
 * 7. Normal(<=2) / Three(<=3) 舞台人数与槽位无冲突
 */

import { snippetHasPreFence } from '../../common/export/snippetSemantics'
import {
  APPEAR_FADE_TOTAL_MS,
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
  return Math.max(1.8, openSec + typingSec + 2.0)
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
      const speed = (str(data.moveSpeed, 'Normal') as keyof typeof MOVE_SPEED_DURATION_MS)
      return (MOVE_SPEED_DURATION_MS[speed] ?? MOVE_SPEED_DURATION_MS.Normal) / 1000
    }
    case 'Move': {
      const speed = (str(data.moveSpeed, 'Normal') as keyof typeof MOVE_SPEED_DURATION_MS)
      return (MOVE_SPEED_DURATION_MS[speed] ?? MOVE_SPEED_DURATION_MS.Normal) / 1000
    }
    case 'BlackOut':
    case 'BlackIn':
    case 'SideFade':
    case 'BlurIn':
    case 'BlurOut':
      return normalizeEffectDurationMs(num(data.duration, 500), 500) / 1000
    case 'SekaiIn':
      return (SEKAI_IN_PRE_DELAY_MS + normalizeEffectDurationMs(num(data.duration, 500), 500)) / 1000
    case 'SekaiOut':
      return (SEKAI_OUT_PRE_DELAY_MS + normalizeEffectDurationMs(num(data.duration, 500), 500)) / 1000
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
  const invalidCatalogAnimations: string[] = []

  const visible = new Map<number, { side: string; offset: number }>()
  let layoutMode: 'Normal' | 'Three' = 'Normal'
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
  const lastAppearMotion = new Map<number, { timeSec: number; facial: string }>()

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const kind = str(snippet.type)
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (isSlow100Slide(snippet)) {
      slow100SlideCount += 1
    }

    if (snippetHasPreFence(snippet as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' })) {
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
      const maxOnStage = layoutMode === 'Three' ? 3 : 2
      if (visible.size >= maxOnStage && !visible.has(modelId)) {
        stageViolationCount += 1
      }
      for (const [otherId, pos] of visible) {
        if (otherId === modelId) continue
        if (pos.side === side || (layoutMode === 'Normal' && (pos.side === 'Center' || side === 'Center'))) {
          stageViolationCount += 1
        }
      }
      visible.set(modelId, { side, offset: num(to.offset, 0) })
      if (str(data.motion).trim()) {
        lastAppearMotion.set(modelId, { timeSec: startSec, facial: str(data.facial) })
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
        if (pos.side === side || (layoutMode === 'Normal' && (pos.side === 'Center' || side === 'Center'))) {
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
        if (!appearInfo) return
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
        if (appearInfo && startSec - appearInfo.timeSec < 0.4 - 1e-6) {
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
  if (activeShaders.size > 0) unclosedEffects.push(`AttachCharacterShader 未在离场前清除 (${[...activeShaders].join(',')})`)
  if (cameraDirty) warnings.push('结尾前 CameraMove / CameraZoom 未复位为 (0,0)/1.0')

  if (slow100SlideCount > 0) issues.push(`存在 ${slow100SlideCount} 条 ±100px Slow 滑入/滑出`)
  if (appearMotionClashCount > 0) issues.push(`存在 ${appearMotionClashCount} 处入场 <0.4s 动作连打`)
  if (missingWindowCloseBeforeTransitionCount > 0) {
    issues.push(`存在 ${missingWindowCloseBeforeTransitionCount} 处转场/Telop/静默拍前未收窗`)
  }
  if (unclosedEffects.length > 0) issues.push(...unclosedEffects)
  if (invalidCatalogAnimations.length > 0) {
    issues.push(`存在未收录的动作/表情：${invalidCatalogAnimations.slice(0, 5).join(', ')}`)
  }
  if (stageViolationCount > 0) issues.push(`舞台槽位/人数违规 ${stageViolationCount} 处`)

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
      inPlaceAppearShare: appearCount > 0 ? Number((inPlaceAppearCount / appearCount).toFixed(3)) : 1,
      stageViolationCount
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
  const lastAppearMotion = new Map<number, { timeSec: number; facial: string }>()
  let dedupedClashes = 0
  let addedCloses = 0

  let flashbackOpen = false
  let sepiaOpen = false
  let shakeScreenActive = false
  let shakeWindowActive = false
  let cameraZoomed = false
  let cameraMoved = false
  const activeShaders = new Set<number>()

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const kind = str(snippet.type)
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (snippetHasPreFence(snippet as { type?: string; wait?: boolean; progressBehavior?: 'Now' | 'WaitFinished' })) {
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
        lastAppearMotion.set(mid, { timeSec: startSec, facial: str(data.facial) })
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
        if (appearInfo && startSec - appearInfo.timeSec < 0.4 - 1e-6) {
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
    }
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
    closers.push({ type: 'StopShakeScreen', wait: false, progressBehavior: 'Now', delay: 0, data: {} })
  }
  if (shakeWindowActive) {
    closers.push({ type: 'StopShakeWindow', wait: false, progressBehavior: 'Now', delay: 0, data: {} })
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
    closers.push({ type: 'FlashbackOut', wait: false, progressBehavior: 'Now', delay: 0, data: { duration: 100 } })
  }
  if (sepiaOpen) {
    closers.push({ type: 'SepiaOut', wait: false, progressBehavior: 'Now', delay: 0, data: { duration: 100 } })
  }
  if (closers.length > 0) {
    snippets.splice(lastBlackOutIndex, 0, ...closers)
    warn(`[Linter] 已在片尾自动补全 ${closers.length} 条未闭合特效/镜头复位指令`)
  }

  const report = lintOfficialStory(story, view)
  for (const issue of report.issues) {
    warn(`[Linter] ${issue}`)
  }
  return report
}
