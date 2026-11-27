import {
  inspectModelFacial,
  isFacialCompatibleWithLine,
  isSmileLikeFacial
} from '../facialSemantics'
import {
  isInternalThoughtContent,
  normalizeLayoutTransitionBarriers,
  syncTalkEmotionContinuity
} from '../officialLinter'
import { isStandingMotion, type CatalogView } from '../prompt'
import { hasTranslationContent } from '../ttsText'
import {
  SMILE_FACIAL_RE,
  TENSE_EMOTION_SET,
  isCheerfulComedyLines,
  isMotionCompatibleWithContext,
  isPrecededByTenseBeat,
  isRestrainedRole,
  pickAppearFallbackMotion,
  pickFollowupMotion,
  pickListenerReactionFacial,
  pickSpeakerSubtleFacial,
  shouldAvoidIncongruousSmile
} from './actingHelpers'
import { activeCast, cleanText, normalizeBackground, num } from './helpers'
import { fallbackStaging, pickOpeningBgmForScene } from './staging'
import type {
  JsonRecord,
  StagedCastMember,
  StagedCastPlan,
  StagedDialogue,
  StagedDialogueLine,
  StagedDirection,
  StagedDirectionLine,
  StagedPresenceSegment,
  StagedStaging,
  StagedStagingEvent,
  StagedStagingScene
} from './types'

/**
 * 根据分幕（或全篇对话）估算站位段，供既有测试与诊断逻辑查询。
 * 保持全篇 Normal 模式（<=2 人同场）与官方 PJSK 一致。
 */
export function planPresence(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  _direction?: StagedDirection,
  staging?: StagedStaging
): StagedPresenceSegment[] {
  if (dialogue.lines.length === 0) return []
  const last = dialogue.lines.length - 1
  if (plan.cast.length === 1) {
    return [
      {
        from: 0,
        to: last,
        mode: 'solo',
        speaker: dialogue.lines[0].speaker,
        castIds: [plan.cast[0].modelId]
      }
    ]
  }
  const scenes = staging?.scenes ?? []
  const hasSoloScene = scenes.some((s) => s.activeCast.length === 1)
  if (plan.cast.length === 2 && !hasSoloScene && scenes.length <= 1) {
    return [{ from: 0, to: last, mode: 'duo', castIds: plan.cast.map((c) => c.modelId) }]
  }
  if (scenes.length > 0) {
    return scenes.map((scene, index) => {
      const to =
        index + 1 < scenes.length
          ? Math.max(scene.fromIndex, scenes[index + 1].fromIndex - 1)
          : last
      const castIds = scene.activeCast.slice(0, 2)
      const count = castIds.length
      return {
        from: scene.fromIndex,
        to,
        mode: count === 2 ? 'duo' : 'solo',
        ...(count === 1 ? { speaker: plan.cast.find((c) => c.modelId === castIds[0])?.name } : {}),
        castIds
      }
    })
  }
  const initialIds = plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.modelId)
  return [
    { from: 0, to: last, mode: initialIds.length === 2 ? 'duo' : 'solo', castIds: initialIds }
  ]
}

type SideSlot = 'Left' | 'Center' | 'Right'

interface StageActorState {
  side: SideSlot
  offset: number
  hologram: boolean
  appearedAtLine: number
  appearedWithMotion: boolean
  lastAppearMotion: string
  appearFacial: string
  lastBodyMotion: string
  consecutiveSameBodyMotion: number
  lastFacial: string
  lastSpeakingFacial: string
  consecutiveSameFacial: number
  lastSpeakingWasShortWithMotion: boolean
  recentBodyMotions: string[]
  speakingCountSinceAppear: number
  linesSinceLastBodyMotion: number
}

interface PendingListenerMotion {
  modelId: number
  motion?: string
  facial?: string
}

interface ComposerContext {
  view: CatalogView
  plan: StagedCastPlan
  dialogue: StagedDialogue
  direction: StagedDirection
  effectiveStaging: StagedStaging
  cast: StagedCastMember[]
  snippets: JsonRecord[]
  registerImage: (file: string) => number
  onStage: Map<number, StageActorState>
  preferredSide: Map<number, 'Left' | 'Right'>
  totalBodyMotions: Map<number, number>
  storyMotionCounts: Map<number, Map<string, number>>
  lastEmotionByActor: Map<number, string>
  directionById: Map<string, StagedDirectionLine>
  sceneByStart: Map<number, StagedStagingScene>
  eventByIndex: Map<number, StagedStagingEvent>
  layoutMode: 'Normal' | null
  windowOpen: boolean
  flashbackActive: boolean
  currentEffect: string
  currentBgm: string
  cameraZoomDirty: boolean
  cameraMoveDirty: boolean
  shakeScreenActive: boolean
  lastSpeakerId: number | null
  lastSilentReactionLine: number
  lastSilentReactionTargetId: number | null
  silentReactionsEmitted: number
  thinkingSoloReturnCast: number[] | null
  maxDelayedTalks: number
  delayedTalkCount: number
}

function mergeLegacyDirectionIntoStaging(
  view: CatalogView,
  dialogue: StagedDialogue,
  direction: StagedDirection,
  effectiveStaging: StagedStaging
): void {
  const s0 = effectiveStaging.scenes[0]
  if (s0) {
    s0.background = normalizeBackground(view, direction.background || s0.background)
    s0.ambient = direction.ambient || s0.ambient
    if (direction.bgm) s0.bgm = direction.bgm
  }
  if (
    direction.background2 &&
    direction.background2From !== undefined &&
    direction.background2From > 0 &&
    effectiveStaging.scenes.length === 1
  ) {
    effectiveStaging.scenes.push({
      id: 's2',
      fromLineId: dialogue.lines[direction.background2From]?.id ?? 'l2',
      fromIndex: direction.background2From,
      background: normalizeBackground(view, direction.background2),
      ambient: direction.ambient || 'normal',
      transitionIn: 'black',
      activeCast: effectiveStaging.scenes[0].activeCast
    })
  }
}

function getOverusedMotions(
  ctx: ComposerContext,
  modelId: number,
  extra?: ReadonlyArray<string>
): Set<string> {
  const out = new Set<string>(extra ?? [])
  const counts = ctx.storyMotionCounts.get(modelId)
  if (counts) {
    for (const [m, c] of counts) {
      if (c >= 2) out.add(m)
    }
  }
  return out
}

function trackActorBodyMotion(
  ctx: ComposerContext,
  st: StageActorState | undefined,
  motionName: string,
  modelId?: number
): void {
  if (!st || !motionName) return
  st.consecutiveSameBodyMotion =
    st.lastBodyMotion === motionName ? st.consecutiveSameBodyMotion + 1 : 1
  st.lastBodyMotion = motionName
  st.linesSinceLastBodyMotion = 0
  if (modelId !== undefined) {
    ctx.totalBodyMotions.set(modelId, (ctx.totalBodyMotions.get(modelId) ?? 0) + 1)
    let actorCounts = ctx.storyMotionCounts.get(modelId)
    if (!actorCounts) {
      actorCounts = new Map<string, number>()
      ctx.storyMotionCounts.set(modelId, actorCounts)
    }
    actorCounts.set(motionName, (actorCounts.get(motionName) ?? 0) + 1)
  }
  if (st.recentBodyMotions.at(-1) !== motionName) {
    st.recentBodyMotions.push(motionName)
    if (st.recentBodyMotions.length > 4) st.recentBodyMotions.shift()
  }
}

function closeWindowBeforeBreak(ctx: ComposerContext): void {
  if (!ctx.windowOpen) return
  for (let i = ctx.snippets.length - 1; i >= 0; i--) {
    if (ctx.snippets[i].type === 'Talk') {
      const d = ctx.snippets[i].data as JsonRecord
      d.closeWindowOnFinish = true
      ctx.windowOpen = false
      return
    }
    if (ctx.snippets[i].type === 'HideTalk') {
      ctx.windowOpen = false
      return
    }
  }
  ctx.snippets.push({ type: 'HideTalk', wait: true, progressBehavior: 'WaitFinished', delay: 0 })
  ctx.windowOpen = false
}

function resetCameraIfNeeded(ctx: ComposerContext): void {
  if (!ctx.cameraZoomDirty && !ctx.cameraMoveDirty) return
  if (ctx.cameraZoomDirty) {
    ctx.snippets.push({
      type: 'CameraZoom',
      wait: !ctx.cameraMoveDirty,
      progressBehavior: !ctx.cameraMoveDirty ? 'WaitFinished' : 'Now',
      delay: 0,
      data: { scale: 1, duration: 400, ease: 'OutQuad' }
    })
    ctx.cameraZoomDirty = false
  }
  if (ctx.cameraMoveDirty) {
    ctx.snippets.push({
      type: 'CameraMove',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { x: 0, y: 0, duration: 400, ease: 'OutQuad' }
    })
    ctx.cameraMoveDirty = false
  }
}

function stopShakeScreenIfNeeded(ctx: ComposerContext): void {
  if (!ctx.shakeScreenActive) return
  ctx.snippets.push({
    type: 'StopShakeScreen',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0,
    data: {}
  })
  ctx.shakeScreenActive = false
}

function ensureNormalLayoutMode(ctx: ComposerContext): void {
  if (ctx.layoutMode === 'Normal') return
  ctx.snippets.push({
    type: 'ChangeLayoutMode',
    wait: false,
    progressBehavior: 'Now',
    delay: 0,
    data: { mode: 'Normal' }
  })
  ctx.layoutMode = 'Normal'
}

function clearActors(ctx: ComposerContext, ids: number[], _walkOutSet = new Set<number>()): number {
  const toClear = ids.filter((id) => ctx.onStage.has(id))
  if (toClear.length === 0) return 0
  toClear.forEach((id, idx) => {
    const state = ctx.onStage.get(id)!
    if (state.hologram) {
      ctx.snippets.push({
        type: 'AttachCharacterShader',
        wait: idx === 0,
        progressBehavior: idx === 0 ? 'WaitFinished' : 'Now',
        delay: 0,
        data: { modelId: id, shader: 'none' }
      })
    }
  })
  toClear.forEach((id, idx) => {
    const state = ctx.onStage.get(id)!
    ctx.snippets.push({
      type: 'LayoutClear',
      wait: idx === 0,
      progressBehavior: idx === 0 ? 'WaitFinished' : 'Now',
      delay: 0,
      data: {
        modelId: id,
        from: { side: state.side, offset: 0 },
        to: { side: state.side, offset: 0 },
        motion: '',
        facial: '',
        moveSpeed: 'Normal'
      }
    })
    ctx.onStage.delete(id)
  })
  return toClear.length
}

function applyBgmDirective(
  ctx: ComposerContext,
  bgmDirective: string | undefined,
  fadeMs = 700
): void {
  if (!bgmDirective || bgmDirective === 'keep') return
  if (bgmDirective === 'silence') {
    if (ctx.currentBgm) {
      ctx.snippets.push({
        type: 'ChangeBgm',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { file: '', stop: true, fadeMs }
      })
      ctx.currentBgm = ''
    }
    return
  }
  if (bgmDirective !== ctx.currentBgm) {
    ctx.snippets.push({
      type: 'ChangeBgm',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { file: bgmDirective, stop: false, fadeMs }
    })
    ctx.currentBgm = bgmDirective
  }
}

function appearActors(
  ctx: ComposerContext,
  targetIds: number[],
  lineIndex: number,
  options: {
    walkInSet?: Set<number>
    walkOutSet?: Set<number>
    hologramSet?: Set<number>
    forceReenter?: boolean
    hadPrecedingClear?: boolean
  } = {}
): void {
  const { view, cast, dialogue, directionById, onStage, preferredSide, snippets } = ctx
  const validIds = targetIds.filter((id) => cast.some((c) => c.modelId === id)).slice(0, 2)
  if (validIds.length === 0) return

  const hologramSet = options.hologramSet ?? new Set<number>()

  const sameGroup =
    !options.forceReenter &&
    ctx.layoutMode === 'Normal' &&
    validIds.length === onStage.size &&
    validIds.every((id) => onStage.has(id))
  if (sameGroup) return

  // Normal 模式槽位分配：<= 2 人时尽量保留在场角色现有的 Left/Right 槽位，避免无意义闪退重入
  const desiredSlotFor = new Map<number, SideSlot>()
  if (validIds.length === 1) {
    desiredSlotFor.set(validIds[0], 'Center')
  } else {
    const freeSlots: SideSlot[] = ['Left', 'Right']
    if (!options.forceReenter) {
      for (const id of validIds) {
        const existing = onStage.get(id)?.side
        if (existing === 'Left' || existing === 'Right') {
          desiredSlotFor.set(id, existing)
          const idx = freeSlots.indexOf(existing)
          if (idx >= 0) freeSlots.splice(idx, 1)
        }
      }
    }
    // 若从 Center 切回双人，优先还原角色原本习惯的 Left/Right 槽位
    for (const id of validIds) {
      if (desiredSlotFor.has(id)) continue
      const pref = preferredSide.get(id)
      if (pref && freeSlots.includes(pref)) {
        desiredSlotFor.set(id, pref)
        freeSlots.splice(freeSlots.indexOf(pref), 1)
      }
    }
    for (const id of validIds) {
      if (!desiredSlotFor.has(id)) {
        const assigned = (freeSlots.shift() ?? 'Right') as 'Left' | 'Right'
        desiredSlotFor.set(id, assigned)
        preferredSide.set(id, assigned)
      }
    }
  }

  // 单人 Center <-> 双人 Left/Right 切镜统一采用「原地 LayoutClear 淡出 -> 原地 LayoutAppear 淡入」，严禁横向 Move 滑动
  const slotShiftedStates = new Map<number, StageActorState>()
  const outgoing: number[] = []
  for (const [id, st] of onStage.entries()) {
    const targetSide = desiredSlotFor.get(id)
    if (!validIds.includes(id) || (targetSide && st.side !== targetSide)) {
      outgoing.push(id)
      if (validIds.includes(id)) {
        slotShiftedStates.set(id, { ...st, recentBodyMotions: [...st.recentBodyMotions] })
      }
    }
  }
  if (outgoing.length > 0) closeWindowBeforeBreak(ctx)
  clearActors(ctx, outgoing)
  ensureNormalLayoutMode(ctx)

  const lineAtEntry = dialogue.lines[lineIndex]
  const directedAtEntry = lineAtEntry ? directionById.get(lineAtEntry.id) : undefined
  const incoming = validIds.filter((id) => !onStage.has(id))
  const usedEntryMotions = new Set<string>()
  incoming.forEach((id, idx) => {
    const slot = desiredSlotFor.get(id)!
    const prevShiftState = slotShiftedStates.get(id)
    // 所有入场严格使用原地渐变淡入（from == to, offset: 0），严禁 LeftOver/RightOver 滑入
    const fromPos = { side: slot, offset: 0 }
    const member = cast.find((c) => c.modelId === id)
    const memberName = member?.name
    const isEntrySpeaker = Boolean(memberName && lineAtEntry?.speaker === memberName)
    const directedMotion =
      isEntrySpeaker && directedAtEntry
        ? (directedAtEntry.beats?.[0]?.motion ?? directedAtEntry.motion)
        : undefined
    const directedFacial =
      isEntrySpeaker && directedAtEntry
        ? (directedAtEntry.beats?.[0]?.facial ?? directedAtEntry.facial)
        : undefined
    let firstFutureTalkMotion = ''
    let firstLineForMember = isEntrySpeaker ? lineAtEntry : undefined
    if (!isEntrySpeaker && memberName) {
      firstLineForMember = dialogue.lines
        .slice(lineIndex + 1, Math.min(dialogue.lines.length, lineIndex + 8))
        .find((l) => l.speaker === memberName)
      const nextDir = firstLineForMember ? directionById.get(firstLineForMember.id) : undefined
      firstFutureTalkMotion = nextDir?.beats?.[0]?.motion ?? nextDir?.motion ?? ''
    }
    const surroundingTense = dialogue.lines
      .slice(Math.max(0, lineIndex - 2), Math.min(dialogue.lines.length, lineIndex + 6))
      .some((l) => TENSE_EMOTION_SET.has(l.emotion ?? ''))
    const entryMemberPath = view.modelById(id)?.path
    const directedMotionOk =
      Boolean(directedMotion) &&
      !isStandingMotion(directedMotion!) &&
      isMotionCompatibleWithContext({
        motion: directedMotion!,
        modelPath: entryMemberPath,
        line: firstLineForMember ?? { content: '', emotion: surroundingTense ? '伤心' : '平静' },
        prevTense: surroundingTense,
        restrainedRole: isRestrainedRole(member?.role ?? '') || isRestrainedRole(member?.name ?? '')
      })
    const entryMotion = directedMotionOk
      ? directedMotion!
      : pickAppearFallbackMotion(
          view,
          id,
          getOverusedMotions(ctx, id, [...usedEntryMotions]),
          firstFutureTalkMotion,
          surroundingTense
        )
    if (entryMotion) usedEntryMotions.add(entryMotion)
    const firstLineIdx = firstLineForMember ? dialogue.lines.indexOf(firstLineForMember) : -1
    const entryPrecededByTense =
      firstLineIdx >= 0 ? isPrecededByTenseBeat(dialogue.lines, firstLineIdx) : surroundingTense
    const safeDirectedFacial = shouldAvoidIncongruousSmile(
      directedFacial,
      firstLineForMember ?? { content: '', emotion: '平静' },
      entryPrecededByTense
    )
      ? ''
      : directedFacial
    const shiftedModelPath = view.modelById(id)?.path
    const preservedShiftFacial =
      prevShiftState?.lastFacial &&
      !shouldAvoidIncongruousSmile(
        prevShiftState.lastFacial,
        firstLineForMember ?? { content: '', emotion: '平静' },
        entryPrecededByTense,
        { modelPath: shiftedModelPath }
      )
        ? prevShiftState.lastFacial
        : ''
    const entryFacial =
      safeDirectedFacial ||
      preservedShiftFacial ||
      (firstLineForMember
        ? pickSpeakerSubtleFacial(view, id, firstLineForMember, undefined, member?.role, {
            precededByTense: entryPrecededByTense,
            modelPath: shiftedModelPath
          })
        : '') ||
      (surroundingTense
        ? pickSpeakerSubtleFacial(
            view,
            id,
            { content: '', emotion: '平静' },
            undefined,
            member?.role,
            { precededByTense: true, modelPath: shiftedModelPath }
          )
        : '') ||
      view.exampleFacial(id) ||
      view.defaultFacial(id)
    const isHolo = hologramSet.has(id)
    const waitFirst = idx === 0
    snippets.push({
      type: 'LayoutAppear',
      wait: waitFirst,
      progressBehavior: waitFirst ? 'WaitFinished' : 'Now',
      delay: 0,
      data: {
        modelId: id,
        from: fromPos,
        to: { side: slot, offset: 0 },
        motion: entryMotion,
        facial: entryFacial,
        facialFirst: true,
        moveSpeed: 'Normal',
        hologram: isHolo
      }
    })
    if (isHolo) {
      snippets.push({
        type: 'AttachCharacterShader',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { modelId: id, shader: 'hologram' }
      })
    }
    onStage.set(id, {
      side: slot,
      offset: 0,
      hologram: isHolo,
      appearedAtLine: lineIndex,
      appearedWithMotion: Boolean(entryMotion),
      lastAppearMotion: entryMotion,
      appearFacial: entryFacial,
      lastBodyMotion: entryMotion || prevShiftState?.lastBodyMotion || '',
      consecutiveSameBodyMotion: entryMotion ? 1 : 0,
      lastFacial: entryFacial,
      lastSpeakingFacial: prevShiftState?.lastSpeakingFacial || '',
      consecutiveSameFacial: prevShiftState?.consecutiveSameFacial ?? 0,
      lastSpeakingWasShortWithMotion: false,
      recentBodyMotions: entryMotion ? [entryMotion] : (prevShiftState?.recentBodyMotions ?? []),
      speakingCountSinceAppear: prevShiftState?.speakingCountSinceAppear ?? 0,
      linesSinceLastBodyMotion: 0
    })
  })
}

function emitOpeningScene(ctx: ComposerContext, scene0: StagedStagingScene): void {
  const { view, plan, dialogue, direction, effectiveStaging, snippets } = ctx
  let initialBgm = scene0.bgm || direction.bgm
  if (
    dialogue.lines.length >= 6 &&
    (!initialBgm || initialBgm === 'keep' || initialBgm === 'silence')
  ) {
    const hasEarlyBgmPlay =
      effectiveStaging.events.some(
        (ev) => ev.lineIndex <= 5 && ev.bgmCut?.action === 'play' && Boolean(ev.bgmCut.file)
      ) ||
      effectiveStaging.scenes
        .slice(1)
        .some((s) => s.fromIndex <= 5 && Boolean(s.bgm) && s.bgm !== 'silence' && s.bgm !== 'keep')
    if (!initialBgm || initialBgm === 'keep' || (initialBgm === 'silence' && !hasEarlyBgmPlay)) {
      const picked = pickOpeningBgmForScene(view, plan, dialogue, plan.scenes?.[0]?.summary ?? '')
      if (picked) initialBgm = picked
    }
  }
  applyBgmDirective(ctx, initialBgm, 600)
  ensureNormalLayoutMode(ctx)
  const bgId = ctx.registerImage(scene0.background)
  snippets.push({
    type: 'BlackOut',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0,
    data: { duration: 0, color: 'black' }
  })
  snippets.push({
    type: 'ChangeBackgroundImage',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0,
    data: { imageId: bgId }
  })
  if (scene0.ambient !== 'normal') {
    snippets.push({
      type: 'AmbientColor',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { mode: scene0.ambient }
    })
  }
  snippets.push({
    type: 'BlackIn',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0,
    data: { duration: 600, color: 'black' }
  })
  if (scene0.telop) {
    snippets.push({
      type: 'Telop',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { content: scene0.telop }
    })
  }
  if (scene0.placeInfo) {
    snippets.push({
      type: 'PlaceInfo',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { text: scene0.placeInfo }
    })
  }
  if (scene0.scenarioEffect) {
    snippets.push({
      type: 'PlayScenarioEffect',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { effectName: scene0.scenarioEffect }
    })
    ctx.currentEffect = scene0.scenarioEffect
  }
  appearActors(ctx, scene0.activeCast, 0, {
    walkInSet: new Set(scene0.walkInCast ?? []),
    hologramSet: new Set(scene0.hologramCast ?? [])
  })
}

function emitSceneTransition(
  ctx: ComposerContext,
  nextScene: StagedStagingScene,
  index: number
): void {
  const { snippets, onStage } = ctx
  ctx.thinkingSoloReturnCast = null
  closeWindowBeforeBreak(ctx)
  stopShakeScreenIfNeeded(ctx)
  resetCameraIfNeeded(ctx)
  if (ctx.currentEffect) {
    snippets.push({
      type: 'StopScenarioEffect',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { effectName: ctx.currentEffect }
    })
    ctx.currentEffect = ''
  }
  applyBgmDirective(ctx, nextScene.bgm, 900)

  const bgId = ctx.registerImage(nextScene.background)
  const enteringFlashback = Boolean(nextScene.isFlashback) && !ctx.flashbackActive
  const leavingFlashback = !nextScene.isFlashback && ctx.flashbackActive
  const tKind = nextScene.transitionIn
  const closeFlashbackBehindCurtain = (): void => {
    if (!leavingFlashback) return
    snippets.push({
      type: 'FlashbackOut',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 100 }
    })
    ctx.flashbackActive = false
  }
  const applySceneBackdropAndCast = (): void => {
    snippets.push({
      type: 'ChangeBackgroundImage',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { imageId: bgId }
    })
    snippets.push({
      type: 'AmbientColor',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { mode: nextScene.ambient }
    })
    appearActors(ctx, nextScene.activeCast, index, {
      walkInSet: new Set(nextScene.walkInCast ?? []),
      hologramSet: new Set(nextScene.hologramCast ?? []),
      forceReenter: true,
      hadPrecedingClear: true
    })
  }

  if (
    tKind === 'flashback' ||
    enteringFlashback ||
    (leavingFlashback && (tKind === 'black' || tKind === 'white'))
  ) {
    snippets.push({
      type: 'BlackOut',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 300, color: 'white' }
    })
    if (enteringFlashback) {
      snippets.push({
        type: 'PlaySe',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { file: 'se00053_b.mp3', volume: 0.9, loop: false, fadeMs: 0 }
      })
    }
    clearActors(ctx, [...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
    if (enteringFlashback) {
      snippets.push({
        type: 'FlashbackIn',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { duration: 100, alpha: 0.3 }
      })
      ctx.flashbackActive = true
    } else {
      closeFlashbackBehindCurtain()
    }
    applySceneBackdropAndCast()
    snippets.push({
      type: 'BlackIn',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 400, color: 'white' }
    })
  } else if (tKind === 'sekaiIn' || tKind === 'sekaiOut') {
    snippets.push({
      type: 'SekaiOut',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 500, variant: 'v2' }
    })
    clearActors(ctx, [...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
    closeFlashbackBehindCurtain()
    applySceneBackdropAndCast()
    snippets.push({
      type: 'SekaiIn',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 500, variant: 'v2' }
    })
  } else if (tKind === 'sideFade') {
    snippets.push({
      type: 'SideFade',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { direction: 'Left', edge: 'left', mode: 'Out', duration: 450 }
    })
    clearActors(ctx, [...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
    closeFlashbackBehindCurtain()
    applySceneBackdropAndCast()
    snippets.push({
      type: 'SideFade',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { direction: 'Right', edge: 'right', mode: 'In', duration: 450 }
    })
  } else {
    const fadeColor = tKind === 'white' ? 'white' : 'black'
    snippets.push({
      type: 'BlackOut',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 400, color: fadeColor }
    })
    clearActors(ctx, [...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
    applySceneBackdropAndCast()
    snippets.push({
      type: 'BlackIn',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 450, color: fadeColor }
    })
  }

  if (nextScene.telop) {
    snippets.push({
      type: 'Telop',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { content: nextScene.telop }
    })
  }
  if (nextScene.placeInfo) {
    snippets.push({
      type: 'PlaceInfo',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { text: nextScene.placeInfo }
    })
  }
  if (nextScene.scenarioEffect) {
    snippets.push({
      type: 'PlayScenarioEffect',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { effectName: nextScene.scenarioEffect }
    })
    ctx.currentEffect = nextScene.scenarioEffect
  }
}

function ensureSpeakerOnStage(
  ctx: ComposerContext,
  index: number,
  member: StagedCastMember,
  ev: StagedStagingEvent | undefined,
  isThinkingLine: boolean
): void {
  const { plan, cast, onStage } = ctx
  // 多人戏若本句说话人尚未在场，安全入场或以 Normal 模式（<=2 人）原地淡出淡入切镜
  if (ev?.stageGroup && plan.cast.length >= 2) {
    const targetGroup = ev.stageGroup.activeCast.includes(member.modelId)
      ? ev.stageGroup.activeCast.slice(0, 2)
      : [member.modelId, ...ev.stageGroup.activeCast.slice(0, 1)]
    const prevIds = [...onStage.keys()]
    if (isThinkingLine && targetGroup.length === 1 && prevIds.length >= 2) {
      ctx.thinkingSoloReturnCast = prevIds
    } else {
      ctx.thinkingSoloReturnCast = null
    }
    appearActors(ctx, targetGroup, index, {
      walkInSet: new Set(ev.stageGroup.walkIn ?? []),
      walkOutSet: new Set(ev.stageGroup.walkOut ?? [])
    })
  } else if (!isThinkingLine && ctx.thinkingSoloReturnCast) {
    const restoreIds = ctx.thinkingSoloReturnCast.includes(member.modelId)
      ? ctx.thinkingSoloReturnCast
      : [member.modelId, ...ctx.thinkingSoloReturnCast.slice(0, 1)]
    ctx.thinkingSoloReturnCast = null
    appearActors(ctx, restoreIds, index)
  } else if (!onStage.has(member.modelId)) {
    if (plan.cast.length >= 3) {
      const currentIds = [...onStage.keys()]
      const keepId =
        ctx.lastSpeakerId !== null && currentIds.includes(ctx.lastSpeakerId)
          ? ctx.lastSpeakerId
          : currentIds[currentIds.length - 1]
      const nextIds =
        currentIds.length < 2 ? [...currentIds, member.modelId] : [keepId, member.modelId]
      appearActors(ctx, nextIds, index)
    } else {
      appearActors(
        ctx,
        cast.map((c) => c.modelId),
        index
      )
    }
  }
}

function emitPreTalkEvents(ctx: ComposerContext, ev: StagedStagingEvent | undefined): void {
  const { snippets, onStage } = ctx
  if (ev?.bgmCut) {
    if (ev.bgmCut.action === 'stop') applyBgmDirective(ctx, 'silence', ev.bgmCut.fadeMs ?? 600)
    else if (ev.bgmCut.file) applyBgmDirective(ctx, ev.bgmCut.file, ev.bgmCut.fadeMs ?? 800)
  }

  if (ev?.se && ev.se.timing !== 'during') {
    snippets.push({
      type: 'PlaySe',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: ev.se.delay ?? 0,
      data: { file: ev.se.file, volume: ev.se.volume ?? 0.9, loop: false, fadeMs: 0 }
    })
  }

  if (ev?.hologram && onStage.has(ev.hologram.modelId)) {
    const st = onStage.get(ev.hologram.modelId)!
    st.hologram = ev.hologram.enabled
    snippets.push({
      type: 'AttachCharacterShader',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { modelId: ev.hologram.modelId, shader: ev.hologram.enabled ? 'hologram' : 'none' }
    })
  }

  // 禁止任何横向 Move 滑动/偏移（原地渐变切镜已由 stageGroup 的 LayoutClear + LayoutAppear 处理）

  if (ev?.characterShake && onStage.has(ev.characterShake.modelId)) {
    snippets.push({
      type: 'CharacterShake',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { modelId: ev.characterShake.modelId, axis: ev.characterShake.axis }
    })
  }

  if (ev?.camera?.kind === 'zoomReset') {
    resetCameraIfNeeded(ctx)
  }
}

function buildLineActions(
  ctx: ComposerContext,
  params: {
    index: number
    line: StagedDialogueLine
    member: StagedCastMember
    ev: StagedStagingEvent | undefined
    directed: StagedDirectionLine | undefined
    actorState: StageActorState | undefined
    talkDelay: number
    precededByTense: boolean
    cheerfulScene: boolean
    speakerModelPath: string | undefined
    speakerRestrained: boolean
    nextSpeakerId: number | null
    nextSpeakerHasImmediateMotion: boolean
  }
): { actions: JsonRecord[]; pendingListenerMotion: PendingListenerMotion | null } {
  const { view, cast, dialogue, direction, onStage, storyMotionCounts, lastEmotionByActor } = ctx
  const {
    index,
    line,
    member,
    ev,
    directed,
    actorState,
    talkDelay,
    precededByTense,
    cheerfulScene,
    speakerModelPath,
    speakerRestrained,
    nextSpeakerId,
    nextSpeakerHasImmediateMotion
  } = params

  const justAppeared =
    Boolean(actorState?.appearedWithMotion) &&
    actorState!.speakingCountSinceAppear === 0 &&
    (ev?.pauseBefore ?? 0) === 0 &&
    index === actorState!.appearedAtLine

  const dedupeFirstSpeakMotion = (rawMotion: string | undefined): string | undefined => {
    if (!rawMotion) return undefined
    if (
      actorState &&
      actorState.speakingCountSinceAppear === 0 &&
      actorState.lastAppearMotion &&
      rawMotion === actorState.lastAppearMotion
    ) {
      const swapped = pickFollowupMotion(
        view,
        member.modelId,
        actorState.lastAppearMotion,
        getOverusedMotions(ctx, member.modelId, actorState.recentBodyMotions)
      )
      return swapped || rawMotion
    }
    return rawMotion
  }

  const justHadStandaloneMotion =
    ctx.lastSilentReactionTargetId === member.modelId &&
    index === ctx.lastSilentReactionLine + 1 &&
    talkDelay < 0.8
  const justHadShortClipMotion =
    ctx.lastSpeakerId === member.modelId &&
    Boolean(actorState?.lastSpeakingWasShortWithMotion) &&
    talkDelay < 0.8
  const skipImmediateBodyMotion = justAppeared || justHadStandaloneMotion || justHadShortClipMotion

  const actions: JsonRecord[] = []
  if (directed?.beats && directed.beats.length > 0) {
    for (const beat of directed.beats) {
      const skipMotion = skipImmediateBodyMotion && beat.at < 0.35
      const motion = skipMotion ? undefined : dedupeFirstSpeakMotion(beat.motion)
      const facial = beat.facial
      if (!motion && !facial) continue
      actions.push({
        at: beat.at,
        modelId: member.modelId,
        ...(motion ? { motion } : {}),
        ...(facial ? { facial } : {})
      })
    }
  } else if (directed?.motion || directed?.facial) {
    const motion = skipImmediateBodyMotion ? undefined : dedupeFirstSpeakMotion(directed.motion)
    const facial = directed.facial
    if (motion || facial) {
      actions.push({
        at: 0,
        modelId: member.modelId,
        ...(motion ? { motion } : {}),
        ...(facial ? { facial } : {})
      })
    }
  }

  // 防止说话人连续多句卡死在 face_normal_01 或同一表情，也防止表情/动作与剧情情绪冲突
  if (actorState) {
    const speakerZeroAct = actions.find((a) => a.modelId === member.modelId && a.at === 0)
    const currentSpeakerFacial =
      typeof speakerZeroAct?.facial === 'string' ? speakerZeroAct.facial : undefined
    const allowStaleCheck = dialogue.lines.length >= 6 && direction.lines.length > 0
    const stuckOnNormal =
      !speakerRestrained &&
      allowStaleCheck &&
      Boolean(currentSpeakerFacial && /^face_normal/i.test(currentSpeakerFacial)) &&
      /^face_normal/i.test(actorState.lastSpeakingFacial || actorState.lastFacial)
    const currentFacialRole = currentSpeakerFacial
      ? inspectModelFacial(speakerModelPath ?? '', currentSpeakerFacial).role
      : 'neutral'
    const isSustainedSadCryLine =
      ['伤心', '害怕', '困惑'].includes(line.emotion ?? '') ||
      /哭|泪|哽咽|抽泣|对不起|求你|不要|别走|原谅|痛苦|难过|崩溃|受不了|委屈|悲伤/.test(
        line.content
      )
    const isSustainedCryRole =
      currentFacialRole === 'cry' ||
      currentFacialRole === 'sad' ||
      currentFacialRole === 'cold_hollow' ||
      (currentFacialRole === 'closed_troubled' &&
        /^face_(cry|sad)/i.test(currentSpeakerFacial ?? ''))
    const repeatThreshold = isSustainedCryRole && isSustainedSadCryLine ? 8 : 2
    const staleRepeatedFacial =
      allowStaleCheck &&
      Boolean(currentSpeakerFacial) &&
      currentSpeakerFacial === actorState.lastSpeakingFacial &&
      actorState.consecutiveSameFacial >= repeatThreshold &&
      !(isSustainedCryRole && isSustainedSadCryLine)
    const incongruousSmile = shouldAvoidIncongruousSmile(
      currentSpeakerFacial,
      line,
      precededByTense,
      { modelPath: speakerModelPath, restrained: speakerRestrained }
    )
    if (stuckOnNormal || staleRepeatedFacial || incongruousSmile) {
      const varied = pickSpeakerSubtleFacial(
        view,
        member.modelId,
        line,
        actorState.lastSpeakingFacial || actorState.lastFacial,
        member.role,
        { precededByTense, modelPath: speakerModelPath, restrained: speakerRestrained }
      )
      if (varied && varied !== currentSpeakerFacial) {
        if (speakerZeroAct) {
          speakerZeroAct.facial = varied
        } else {
          actions.unshift({ at: 0, modelId: member.modelId, facial: varied })
        }
      }
    }

    // 校验说话者身体动作是否与剧情情绪冲突；仅在连续 >=4 句重复同一动作时温和切换，避免为了防重复乱切动作
    const speakerMotionAct = actions.find(
      (a) =>
        a.modelId === member.modelId && typeof a.motion === 'string' && a.motion.trim().length > 0
    )
    const currentSpeakerMotion =
      typeof speakerMotionAct?.motion === 'string' ? speakerMotionAct.motion.trim() : ''
    if (currentSpeakerMotion && speakerMotionAct) {
      const motionCompat = isMotionCompatibleWithContext({
        motion: currentSpeakerMotion,
        modelPath: speakerModelPath,
        line,
        prevTense: precededByTense,
        restrainedRole: speakerRestrained,
        cheerfulScene
      })
      const repeatedTooLong =
        allowStaleCheck &&
        ((currentSpeakerMotion === actorState.lastBodyMotion &&
          actorState.consecutiveSameBodyMotion >= 4) ||
          ((storyMotionCounts.get(member.modelId)?.get(currentSpeakerMotion) ?? 0) >= 3 &&
            !(
              currentSpeakerMotion === actorState.lastBodyMotion &&
              actorState.consecutiveSameBodyMotion <= 2
            )))
      if (!motionCompat || repeatedTooLong) {
        const replacement = pickFollowupMotion(
          view,
          member.modelId,
          currentSpeakerMotion,
          getOverusedMotions(ctx, member.modelId, actorState.recentBodyMotions),
          { line, prevTense: precededByTense, restrained: speakerRestrained }
        )
        if (replacement && replacement !== currentSpeakerMotion) {
          speakerMotionAct.motion = replacement
        } else if (!motionCompat) {
          delete speakerMotionAct.motion
        }
      }
    }
  }

  let pendingListenerMotion: PendingListenerMotion | null = null
  if (
    directed?.listener &&
    directed.listener.modelId !== member.modelId &&
    onStage.has(directed.listener.modelId)
  ) {
    const listenerState = onStage.get(directed.listener.modelId)
    const listenerModelPath = view.modelById(directed.listener.modelId)?.path
    const listenerMember = cast.find((c) => c.modelId === directed.listener!.modelId)
    const listenerRestrained =
      isRestrainedRole(listenerMember?.role ?? '') || isRestrainedRole(listenerMember?.name ?? '')
    const listenerJustAppeared =
      Boolean(listenerState?.appearedWithMotion) &&
      index === (listenerState?.appearedAtLine ?? -99) &&
      (ev?.pauseBefore ?? 0) === 0
    const listenerJustHadStandalone: boolean =
      ctx.lastSilentReactionTargetId === directed.listener.modelId &&
      index === ctx.lastSilentReactionLine + 1 &&
      talkDelay < 0.8
    const listenerMotion: string | undefined =
      listenerJustAppeared || listenerJustHadStandalone ? undefined : directed.listener.motion
    const listenerPrecededByTense = precededByTense || TENSE_EMOTION_SET.has(line.emotion ?? '')
    const listenerPrevEmo = lastEmotionByActor.get(directed.listener.modelId) ?? ''
    const listenerPrevFacialRole = listenerState?.lastFacial
      ? inspectModelFacial(listenerModelPath ?? '', listenerState.lastFacial).role
      : 'neutral'
    const listenerHadTenseMood =
      listenerPrevEmo === '生气' ||
      listenerPrevEmo === '伤心' ||
      listenerPrevEmo === '害怕' ||
      listenerPrevFacialRole === 'angry' ||
      listenerPrevFacialRole === 'sad' ||
      listenerPrevFacialRole === 'cry' ||
      listenerPrevFacialRole === 'trouble' ||
      listenerPrevFacialRole === 'cold_hollow' ||
      listenerPrevFacialRole === 'closed_troubled'
    const listenerFacialRaw = directed.listener.facial
    const forbiddenTenseSmile =
      Boolean(listenerFacialRaw) &&
      (listenerHadTenseMood || listenerPrecededByTense) &&
      (SMILE_FACIAL_RE.test(listenerFacialRaw!) ||
        isSmileLikeFacial(listenerFacialRaw!, listenerModelPath))
    const listenerFacial =
      forbiddenTenseSmile ||
      shouldAvoidIncongruousSmile(listenerFacialRaw, line, listenerPrecededByTense, {
        modelPath: listenerModelPath,
        restrained: listenerRestrained
      })
        ? pickListenerReactionFacial(
            view,
            directed.listener.modelId,
            line,
            listenerMember?.role,
            listenerState?.lastFacial,
            {
              precededByTense: listenerPrecededByTense || listenerHadTenseMood,
              modelPath: listenerModelPath,
              restrained: listenerRestrained,
              listenerPrevEmotion: listenerPrevEmo
            }
          )
        : listenerFacialRaw
    const speakerBodyActedThisLine = actions.some(
      (a) =>
        a.modelId === member.modelId &&
        num(a.at) < 0.25 &&
        typeof a.motion === 'string' &&
        a.motion.trim().length > 0
    )
    if (listenerMotion || listenerFacial) {
      if (!listenerMotion || !speakerBodyActedThisLine || dialogue.lines.length < 6) {
        actions.push({
          at: 0,
          modelId: directed.listener.modelId,
          ...(listenerMotion ? { motion: listenerMotion } : {}),
          ...(listenerFacial ? { facial: listenerFacial } : {})
        })
      } else if (
        !ev?.silentReaction &&
        !directed?.silentMotion &&
        index < dialogue.lines.length - 1 &&
        !(directed.listener.modelId === nextSpeakerId && nextSpeakerHasImmediateMotion)
      ) {
        pendingListenerMotion = {
          modelId: directed.listener.modelId,
          ...(listenerMotion ? { motion: listenerMotion } : {}),
          ...(listenerFacial ? { facial: listenerFacial } : {})
        }
      }
    }
  }

  return { actions, pendingListenerMotion }
}

function willActorClearImmediatelyAfter(
  ctx: ComposerContext,
  index: number,
  member: StagedCastMember,
  targetId: number,
  includeSceneCurtain = true
): boolean {
  const { plan, cast, dialogue, onStage, sceneByStart, eventByIndex } = ctx
  if (!onStage.has(targetId)) return true
  const nextIndex = index + 1
  if (nextIndex >= dialogue.lines.length) return true
  if (sceneByStart.has(nextIndex)) return includeSceneCurtain
  const nLine = dialogue.lines[nextIndex]
  const nMember = cast.find((c) => c.name === nLine.speaker)
  if (!nMember) return false
  const nEv = eventByIndex.get(nextIndex)
  const nIsThinking =
    nLine.windowDisplayMode === 'Thinking' ||
    nLine.effect === 'Internal' ||
    isInternalThoughtContent(nLine.content)
  const currentSide = onStage.get(targetId)?.side

  let nextGroup: number[] | null = null
  if (nEv?.stageGroup && plan.cast.length >= 2) {
    nextGroup = nEv.stageGroup.activeCast.includes(nMember.modelId)
      ? nEv.stageGroup.activeCast.slice(0, 2)
      : [nMember.modelId, ...nEv.stageGroup.activeCast.slice(0, 1)]
  } else if (!nIsThinking && ctx.thinkingSoloReturnCast) {
    nextGroup = ctx.thinkingSoloReturnCast.includes(nMember.modelId)
      ? ctx.thinkingSoloReturnCast
      : [nMember.modelId, ...ctx.thinkingSoloReturnCast.slice(0, 1)]
  } else if (!onStage.has(nMember.modelId)) {
    if (plan.cast.length >= 3) {
      const currentIds = [...onStage.keys()]
      const keepId = currentIds.includes(member.modelId)
        ? member.modelId
        : currentIds[currentIds.length - 1]
      nextGroup =
        currentIds.length < 2 ? [...currentIds, nMember.modelId] : [keepId, nMember.modelId]
    } else {
      nextGroup = cast.map((c) => c.modelId)
    }
  }

  if (!nextGroup) return false
  const validNext = nextGroup.filter((id) => cast.some((c) => c.modelId === id)).slice(0, 2)
  if (validNext.length === 0) return false
  if (!validNext.includes(targetId)) return true
  if (validNext.length === 1 && currentSide !== 'Center') return true
  if (validNext.length >= 2 && currentSide === 'Center') return true
  return false
}

function pickAutoSilentTarget(
  ctx: ComposerContext,
  params: {
    index: number
    line: StagedDialogueLine
    member: StagedCastMember
    ev: StagedStagingEvent | undefined
    explicitSilentReaction: boolean
    pendingListenerMotion: PendingListenerMotion | null
    nextLine: StagedDialogueLine | undefined
    nextSpeakerId: number | null
    nextTalkPause: number
    nextSpeakerHasImmediateMotion: boolean
  }
): number | null {
  const { dialogue, direction, onStage, totalBodyMotions } = ctx
  const {
    index,
    line,
    member,
    ev,
    explicitSilentReaction,
    pendingListenerMotion,
    nextLine,
    nextSpeakerId,
    nextTalkPause,
    nextSpeakerHasImmediateMotion
  } = params
  const hasZeroMotionActorOnStage = [...onStage.entries()].some(
    ([pid, pst]) => index > pst.appearedAtLine && (totalBodyMotions.get(pid) ?? 0) === 0
  )
  const minSilentGap = hasZeroMotionActorOnStage ? 1 : 2
  if (
    explicitSilentReaction ||
    pendingListenerMotion ||
    dialogue.lines.length < 6 ||
    direction.lines.length === 0 ||
    index < 1 ||
    index >= dialogue.lines.length - 1 ||
    ev?.move ||
    index - ctx.lastSilentReactionLine < minSilentGap ||
    ctx.silentReactionsEmitted >= Math.max(2, Math.round(dialogue.lines.length * 0.42))
  ) {
    return null
  }
  const turnBoundary = nextLine && nextLine.speaker !== line.speaker
  const pauseOrEllipsis =
    /……|——/.test(line.content) || Boolean(ev?.closeWindowAfter || line.closeWindowAfter)
  const eligibleCandidates = [...onStage.entries()]
    .filter(
      ([pid, pst]) =>
        index > pst.appearedAtLine &&
        !willActorClearImmediatelyAfter(ctx, index, member, pid) &&
        (pid !== nextSpeakerId || nextTalkPause >= 0.8 || !nextSpeakerHasImmediateMotion)
    )
    .sort(([aid], [bid]) => (totalBodyMotions.get(aid) ?? 0) - (totalBodyMotions.get(bid) ?? 0))
  const idlePartner = eligibleCandidates.find(
    ([pid, pst]) => pid !== member.modelId && pst.linesSinceLastBodyMotion >= 2
  )
  const fallbackOffTurn =
    eligibleCandidates.find(([pid]) => pid !== member.modelId && pid !== nextSpeakerId) ??
    eligibleCandidates.find(([pid]) => pid !== nextSpeakerId) ??
    eligibleCandidates[0]
  if (
    hasZeroMotionActorOnStage ||
    pauseOrEllipsis ||
    idlePartner ||
    (turnBoundary && index % 4 === 2)
  ) {
    const picked = idlePartner ?? fallbackOffTurn
    if (picked) return picked[0]
  }
  return null
}

function emitPostTalkCameraEvent(ctx: ComposerContext, ev: StagedStagingEvent | undefined): void {
  if (!ev?.camera || ev.camera.kind === 'zoomReset') return
  const { snippets } = ctx
  const cam = ev.camera
  if (cam.kind === 'zoomIn') {
    snippets.push({
      type: 'CameraZoom',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { scale: cam.scale ?? 1.1, duration: cam.durationMs ?? 500, ease: 'OutQuad' }
    })
    ctx.cameraZoomDirty = true
  } else if (cam.kind === 'pan') {
    snippets.push({
      type: 'CameraMove',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { x: cam.x ?? 60, y: cam.y ?? 0, duration: cam.durationMs ?? 500, ease: 'OutQuad' }
    })
    ctx.cameraMoveDirty = true
  } else if (cam.kind === 'shakeWindow') {
    snippets.push({
      type: 'ShakeWindow',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { duration: cam.durationMs ?? 450 }
    })
  } else if (cam.kind === 'shakeScreen') {
    const dur = cam.durationMs ?? 450
    snippets.push({
      type: 'ShakeScreen',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { duration: dur, amplitude: 0.01 }
    })
    if (dur >= 10000) ctx.shakeScreenActive = true
  }
}

function emitSilentReactionSnippet(
  ctx: ComposerContext,
  params: {
    index: number
    line: StagedDialogueLine
    member: StagedCastMember
    ev: StagedStagingEvent | undefined
    directed: StagedDirectionLine | undefined
    pendingListenerMotion: PendingListenerMotion | null
    autoSilentTargetId: number | null
    nextSpeakerId: number | null
    precededByTense: boolean
    actedBodyThisLine: Set<number>
  }
): void {
  const { view, cast, onStage, lastEmotionByActor, snippets } = ctx
  const {
    index,
    line,
    member,
    ev,
    directed,
    pendingListenerMotion,
    autoSilentTargetId,
    nextSpeakerId,
    precededByTense,
    actedBodyThisLine
  } = params

  const offTurnCandidateId =
    [...onStage.entries()].find(
      ([id, st]) =>
        id !== nextSpeakerId &&
        id !== member.modelId &&
        index > st.appearedAtLine &&
        !willActorClearImmediatelyAfter(ctx, index, member, id)
    )?.[0] ??
    [...onStage.entries()].find(
      ([id, st]) =>
        id !== nextSpeakerId &&
        index > st.appearedAtLine &&
        !willActorClearImmediatelyAfter(ctx, index, member, id)
    )?.[0]
  const partnerId = [...onStage.keys()].find((id) => id !== member.modelId)
  const targetId: number =
    ev?.silentReaction && onStage.has(ev.silentReaction.modelId)
      ? ev.silentReaction.modelId
      : pendingListenerMotion && onStage.has(pendingListenerMotion.modelId)
        ? pendingListenerMotion.modelId
        : autoSilentTargetId !== null && onStage.has(autoSilentTargetId)
          ? autoSilentTargetId
          : directed?.silentMotion && offTurnCandidateId !== undefined
            ? offTurnCandidateId
            : directed?.silentMotion &&
                partnerId !== undefined &&
                index > (onStage.get(partnerId)?.appearedAtLine ?? -1)
              ? partnerId
              : onStage.has(member.modelId)
                ? member.modelId
                : -1
  const avoidClobberingShortSelfMotion =
    !ev?.silentReaction &&
    targetId === member.modelId &&
    !hasTranslationContent(line.content) &&
    actedBodyThisLine.has(member.modelId)
  const isExplicitStagingSilent = Boolean(
    ev?.silentReaction && onStage.has(ev.silentReaction.modelId)
  )
  if (
    targetId === -1 ||
    !onStage.has(targetId) ||
    avoidClobberingShortSelfMotion ||
    willActorClearImmediatelyAfter(ctx, index, member, targetId, !isExplicitStagingSilent)
  ) {
    return
  }

  const targetState = onStage.get(targetId)!
  const targetMember = cast.find((c) => c.modelId === targetId)
  const targetModelPath = view.modelById(targetId)?.path
  const fromPendingListener =
    pendingListenerMotion?.modelId === targetId ? pendingListenerMotion : null
  const silentPrecededByTense = precededByTense || TENSE_EMOTION_SET.has(line.emotion ?? '')
  const targetPrevEmo = lastEmotionByActor.get(targetId) ?? ''
  const targetRestrained =
    isRestrainedRole(targetMember?.role ?? '') || isRestrainedRole(targetMember?.name ?? '')
  const rawSilentMotion = ev?.silentReaction?.motion || fromPendingListener?.motion || ''
  const safeSilentMotion =
    rawSilentMotion &&
    isMotionCompatibleWithContext({
      motion: rawSilentMotion,
      modelPath: targetModelPath,
      line,
      prevTense: silentPrecededByTense,
      isListener: targetId !== member.modelId,
      restrainedRole: targetRestrained
    })
      ? rawSilentMotion
      : ''
  const motion =
    safeSilentMotion ||
    pickFollowupMotion(
      view,
      targetId,
      targetState.lastBodyMotion,
      getOverusedMotions(ctx, targetId, targetState.recentBodyMotions),
      { line, prevTense: silentPrecededByTense, restrained: targetRestrained }
    )
  const rawSilentFacial = ev?.silentReaction?.facial || fromPendingListener?.facial || ''
  const targetHadTense =
    silentPrecededByTense ||
    targetPrevEmo === '生气' ||
    targetPrevEmo === '伤心' ||
    targetPrevEmo === '害怕'
  const safeSilentFacial =
    (rawSilentFacial &&
      targetHadTense &&
      (SMILE_FACIAL_RE.test(rawSilentFacial) ||
        isSmileLikeFacial(rawSilentFacial, targetModelPath))) ||
    shouldAvoidIncongruousSmile(rawSilentFacial, line, silentPrecededByTense, {
      modelPath: targetModelPath
    })
      ? ''
      : rawSilentFacial
  const holdExistingCryFacial =
    !safeSilentFacial &&
    Boolean(targetState.lastFacial) &&
    silentPrecededByTense &&
    (() => {
      const r = inspectModelFacial(targetModelPath ?? '', targetState.lastFacial).role
      return r === 'cry' || r === 'sad'
    })()
  const facial =
    safeSilentFacial ||
    (holdExistingCryFacial
      ? ''
      : directed?.silentMotion ||
          autoSilentTargetId !== null ||
          rawSilentFacial ||
          fromPendingListener
        ? targetId === member.modelId
          ? pickSpeakerSubtleFacial(
              view,
              targetId,
              line,
              targetState.lastFacial,
              targetMember?.role,
              { precededByTense: silentPrecededByTense, modelPath: targetModelPath }
            )
          : pickListenerReactionFacial(
              view,
              targetId,
              line,
              targetMember?.role,
              targetState.lastFacial,
              {
                precededByTense: targetHadTense,
                modelPath: targetModelPath,
                listenerPrevEmotion: targetPrevEmo
              }
            )
        : '') ||
    ''
  if (motion || facial) {
    snippets.push({
      type: 'Motion',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0.25,
      data: {
        modelId: targetId,
        motion: motion || '',
        facial: facial || '',
        facialFirst: true
      }
    })
    trackActorBodyMotion(ctx, targetState, motion, targetId)
    if (facial) targetState.lastFacial = facial
    ctx.lastSilentReactionLine = index
    ctx.lastSilentReactionTargetId = targetId
    ctx.silentReactionsEmitted += 1
  }
}

function emitClosingCurtain(ctx: ComposerContext): void {
  const { snippets, onStage, direction } = ctx
  closeWindowBeforeBreak(ctx)
  stopShakeScreenIfNeeded(ctx)
  resetCameraIfNeeded(ctx)
  if (ctx.currentEffect) {
    snippets.push({
      type: 'StopScenarioEffect',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { effectName: ctx.currentEffect }
    })
  }
  if (ctx.currentBgm && direction.bgmStop) {
    snippets.push({
      type: 'ChangeBgm',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { file: '', stop: true, fadeMs: 800 }
    })
  }
  clearActors(ctx, [...onStage.keys()])
  if (ctx.flashbackActive) {
    snippets.push({
      type: 'FlashbackOut',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { duration: 100 }
    })
  }
  snippets.push({
    type: 'BlackOut',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0,
    data: { duration: 600, color: 'black' }
  })
}

/**
 * 把五阶段结果合成为官方 PJSK 规范的 StoryData。
 *
 * 保持全片 Normal 模式（<=2 人同场）、双人全片同场、多人 2 人交叠淡出淡入轮换、
 * 99% 原地淡入淡出、93% delay=0、入场防重叠去重、转场前 closeWindowOnFinish、
 * Move/PlaySe/SideFade/Flashback/Sekai/Hologram 全部精确对齐。
 */
export function composeStory(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  direction: StagedDirection,
  staging?: StagedStaging
): JsonRecord {
  const effectiveStaging =
    staging && staging.scenes.length > 0 ? staging : fallbackStaging(view, plan, dialogue)
  const cast = activeCast(plan, dialogue, direction, effectiveStaging)
  if (cast.length === 0) throw new Error('台词稿没有可用的出场角色')

  // 如果 direction 指定了 background2 / ambient / bgm2（旧单测或 3 段路径），合并入分幕表
  if (!staging) {
    mergeLegacyDirectionIntoStaging(view, dialogue, direction, effectiveStaging)
  }

  const imageMap = new Map<string, number>()
  const images: Array<{ id: number; image: string }> = []
  const registerImage = (file: string): number => {
    const normalized = normalizeBackground(view, file)
    if (!normalized) return 1
    const existing = imageMap.get(normalized)
    if (existing !== undefined) return existing
    const id = images.length + 1
    imageMap.set(normalized, id)
    images.push({ id, image: normalized })
    return id
  }
  for (const scene of effectiveStaging.scenes) {
    registerImage(scene.background)
  }
  if (images.length === 0) registerImage(direction.background || plan.background)

  const models = cast.map((member) => ({
    id: member.modelId,
    model: member.path,
    normal_scale: 2.1,
    small_scale: 1.8,
    anchor: 0.5
  }))

  const preferredSide = new Map<number, 'Left' | 'Right'>()
  if (cast.length === 2) {
    preferredSide.set(cast[0].modelId, 'Left')
    preferredSide.set(cast[1].modelId, 'Right')
  }

  const ctx: ComposerContext = {
    view,
    plan,
    dialogue,
    direction,
    effectiveStaging,
    cast,
    snippets: [],
    registerImage,
    onStage: new Map<number, StageActorState>(),
    preferredSide,
    totalBodyMotions: new Map<number, number>(),
    storyMotionCounts: new Map<number, Map<string, number>>(),
    lastEmotionByActor: new Map<number, string>(),
    directionById: new Map(direction.lines.map((line) => [line.id, line])),
    sceneByStart: new Map(effectiveStaging.scenes.slice(1).map((s) => [s.fromIndex, s])),
    eventByIndex: new Map(effectiveStaging.events.map((e) => [e.lineIndex, e])),
    layoutMode: null,
    windowOpen: false,
    flashbackActive: false,
    currentEffect: '',
    currentBgm: '',
    cameraZoomDirty: false,
    cameraMoveDirty: false,
    shakeScreenActive: false,
    lastSpeakerId: null,
    lastSilentReactionLine: -10,
    lastSilentReactionTargetId: null,
    silentReactionsEmitted: 0,
    thinkingSoloReturnCast: null,
    // 控制停顿预算：保证 Talk.delay == 0 占比 >= 88%，满足官方 >=85% 节奏基线
    maxDelayedTalks: Math.max(1, Math.floor(dialogue.lines.length * 0.12)),
    delayedTalkCount: 0
  }

  // ---- 开场首幕 -------------------------------------------------------------------------------------------
  const scene0 = effectiveStaging.scenes[0]
  if (scene0) {
    emitOpeningScene(ctx, scene0)
  }

  // ---- 逐句编译分幕转场、走位事件、音效与表演 ----------------------------------------------------------------
  for (let index = 0; index < dialogue.lines.length; index++) {
    const nextScene = ctx.sceneByStart.get(index)
    if (nextScene) {
      emitSceneTransition(ctx, nextScene, index)
    }

    // 兼容旧 direction.bgm2 写法（当没有 staging 分幕 BGM 时）
    if (!staging && direction.bgm2 && direction.bgm2From === index) {
      applyBgmDirective(ctx, direction.bgm2, 1200)
    }

    const line = dialogue.lines[index]
    const member = cast.find((entry) => entry.name === line.speaker)
    if (!member) continue
    const ev = ctx.eventByIndex.get(index)
    const isThinkingLine =
      line.windowDisplayMode === 'Thinking' ||
      line.effect === 'Internal' ||
      isInternalThoughtContent(line.content)

    ensureSpeakerOnStage(ctx, index, member, ev, isThinkingLine)
    emitPreTalkEvents(ctx, ev)

    // ---- Talk 动作与入场去重 --------------------------------------------------------------------------------
    const directed = ctx.directionById.get(line.id)
    const actorState = ctx.onStage.get(member.modelId)
    const rawTalkDelay = ev?.pauseBefore ?? line.pauseBefore ?? 0
    let talkDelay = rawTalkDelay
    if (talkDelay > 0) {
      if (ctx.delayedTalkCount < ctx.maxDelayedTalks) {
        ctx.delayedTalkCount += 1
      } else {
        talkDelay = 0
      }
    }

    const cheerfulScene = isCheerfulComedyLines(dialogue.lines, index)
    const precededByTense = isPrecededByTenseBeat(dialogue.lines, index)
    const speakerModelPath = view.modelById(member.modelId)?.path
    const speakerRestrained = isRestrainedRole(member.role) || isRestrainedRole(member.name)

    const nextLine = index + 1 < dialogue.lines.length ? dialogue.lines[index + 1] : undefined
    const nextSpeakerId = nextLine
      ? (cast.find((c) => c.name === nextLine.speaker)?.modelId ?? null)
      : null
    const nextEvent =
      index + 1 < dialogue.lines.length ? ctx.eventByIndex.get(index + 1) : undefined
    const nextTalkPause = nextEvent?.pauseBefore ?? nextLine?.pauseBefore ?? 0
    const nextDir = nextLine ? ctx.directionById.get(nextLine.id) : undefined
    const nextSpeakerHasImmediateMotion =
      nextTalkPause < 0.8 && Boolean(nextDir?.beats?.[0]?.motion ?? nextDir?.motion)

    const { actions, pendingListenerMotion } = buildLineActions(ctx, {
      index,
      line,
      member,
      ev,
      directed,
      actorState,
      talkDelay,
      precededByTense,
      cheerfulScene,
      speakerModelPath,
      speakerRestrained,
      nextSpeakerId,
      nextSpeakerHasImmediateMotion
    })

    if (actorState) {
      actorState.speakingCountSinceAppear += 1
      actorState.appearedWithMotion = false
    }

    const explicitSilentReaction = Boolean(ev?.silentReaction || directed?.silentMotion)
    const autoSilentTargetId = pickAutoSilentTarget(ctx, {
      index,
      line,
      member,
      ev,
      explicitSilentReaction,
      pendingListenerMotion,
      nextLine,
      nextSpeakerId,
      nextTalkPause,
      nextSpeakerHasImmediateMotion
    })
    const hasSilentAfter =
      explicitSilentReaction || pendingListenerMotion !== null || autoSilentTargetId !== null
    // 仅当调用方显式要求关窗（如停顿/场景切镜前）才设 closeWindowAfter；严禁因瞬时 Motion 静默拍反复关闭并闪烁对话框
    const closeAfter = Boolean(ev?.closeWindowAfter || line.closeWindowAfter)

    // 官方 TalkData.Motions 每条动作都同时带 MotionName 与 FacialName；
    // 回填时必须校验情绪兼容性，绝不把之前残留的笑脸带进伤心/生气/紧张台词。
    const rawLastFacial = actorState?.lastFacial || ''
    let speakerFacial =
      rawLastFacial &&
      isFacialCompatibleWithLine({
        facial: rawLastFacial,
        modelPath: speakerModelPath,
        emotion: line.emotion,
        content: line.content,
        prevTense: precededByTense,
        restrainedRole: speakerRestrained
      }).ok
        ? rawLastFacial
        : ''
    const speakerActs = actions
      .filter((action) => action.modelId === member.modelId)
      .sort((a, b) => num(a.at) - num(b.at))
    for (const action of speakerActs) {
      const facial = typeof action.facial === 'string' ? action.facial.trim() : ''
      if (facial) {
        speakerFacial = facial
        continue
      }
      const motion = typeof action.motion === 'string' ? action.motion.trim() : ''
      if (!motion) continue
      const filled =
        speakerFacial ||
        pickSpeakerSubtleFacial(view, member.modelId, line, '', member.role, {
          precededByTense,
          modelPath: speakerModelPath,
          restrained: speakerRestrained
        }) ||
        view.neutralFacial(member.modelId)
      action.facial = filled
      speakerFacial = filled
    }

    ctx.snippets.push({
      type: 'Talk',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: talkDelay,
      data: {
        speaker: member.name,
        content: line.content,
        ttsText: line.ttsText ?? '',
        emotion: line.emotion ?? '',
        ...(line.windowDisplayMode ? { windowDisplayMode: line.windowDisplayMode } : {}),
        ...(line.effect ? { effect: line.effect } : {}),
        ...(line.ttsCaption ? { ttsCaption: line.ttsCaption } : {}),
        ...(typeof line.ttsSpeed === 'number' ? { ttsSpeed: line.ttsSpeed } : {}),
        ...(line.ttsSpecialScene ? { ttsSpecialScene: true } : {}),
        modelId: member.modelId,
        ...(closeAfter ? { closeWindowOnFinish: true } : {}),
        ...(actions.length > 0 ? { actions } : {})
      }
    })
    ctx.windowOpen = !closeAfter
    ctx.lastSpeakerId = member.modelId
    if (line.emotion) ctx.lastEmotionByActor.set(member.modelId, line.emotion)

    // 随本句 Talk 同步触发的镜头推进/震动放在 Talk 之后并置 Now，保证在本句起始帧同步启动而非提前在上句抢跑
    emitPostTalkCameraEvent(ctx, ev)

    const actedBodyThisLine = new Set<number>()
    for (const act of actions) {
      const aid = typeof act.modelId === 'number' ? act.modelId : member.modelId
      const ast = ctx.onStage.get(aid)
      if (!ast) continue
      if (typeof act.motion === 'string' && act.motion.length > 0) {
        trackActorBodyMotion(ctx, ast, act.motion, aid)
        actedBodyThisLine.add(aid)
      }
      if (typeof act.facial === 'string' && act.facial.length > 0) {
        if (aid === member.modelId) {
          ast.consecutiveSameFacial =
            ast.lastSpeakingFacial === act.facial ? ast.consecutiveSameFacial + 1 : 1
          ast.lastSpeakingFacial = act.facial
        }
        ast.lastFacial = act.facial
      }
    }
    if (actorState) {
      const visibleLen = cleanText(line.content).replace(/\s+/g, '').length
      actorState.lastSpeakingWasShortWithMotion =
        actedBodyThisLine.has(member.modelId) &&
        (!hasTranslationContent(line.content) || visibleLen <= 5)
    }
    for (const [aid, ast] of ctx.onStage) {
      if (!actedBodyThisLine.has(aid)) {
        ast.linesSinceLastBodyMotion += 1
      }
    }

    if (ev?.se && ev.se.timing === 'during') {
      ctx.snippets.push({
        type: 'PlaySe',
        wait: false,
        progressBehavior: 'Now',
        delay: ev.se.delay ?? 0.15,
        data: { file: ev.se.file, volume: ev.se.volume ?? 0.9, loop: false, fadeMs: 0 }
      })
    }

    if (hasSilentAfter) {
      emitSilentReactionSnippet(ctx, {
        index,
        line,
        member,
        ev,
        directed,
        pendingListenerMotion,
        autoSilentTargetId,
        nextSpeakerId,
        precededByTense,
        actedBodyThisLine
      })
    }
  }

  // ---- 收尾与全部效果闭合 ----------------------------------------------------------------------------------
  emitClosingCurtain(ctx)

  normalizeLayoutTransitionBarriers(ctx.snippets)
  syncTalkEmotionContinuity(ctx.snippets, { models, view })

  return { models, images, snippets: ctx.snippets }
}
