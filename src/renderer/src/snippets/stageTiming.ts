import type { App } from '../app/App'
import type { LayoutModes } from '../../../common/types/Story'

interface StageTimingState {
  layoutEndMs: number
  motionEndByModel: Map<number, number>
  lastClockMs: number
}

export type ClockBaselineResetListener = (now: number) => void

const stageTimingByApp = new WeakMap<object, StageTimingState>()
const clockBaselineResetListeners = new Set<ClockBaselineResetListener>()

export function registerClockBaselineResetListener(
  listener: ClockBaselineResetListener
): () => void {
  clockBaselineResetListeners.add(listener)
  return () => {
    clockBaselineResetListeners.delete(listener)
  }
}

function getState(app: object, now = nowMs()): StageTimingState {
  let state = stageTimingByApp.get(app)
  if (!state) {
    state = { layoutEndMs: 0, motionEndByModel: new Map(), lastClockMs: now }
    stageTimingByApp.set(app, state)
  } else {
    syncClockEpoch(state, now)
  }
  return state
}

function syncClockEpoch(state: StageTimingState, now = nowMs()): void {
  if (!Number.isFinite(now)) return
  if (now < state.lastClockMs) {
    state.layoutEndMs = 0
    state.motionEndByModel.clear()
  }
  state.lastClockMs = now
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function resetClockBaselines(app?: App | object, now = nowMs()): void {
  if (app) {
    stageTimingByApp.delete(app)
    const layerModel = (
      app as {
        layerModel?: {
          children?: Iterable<{ resetClockBaselines?: (now?: number) => void }>
        }
      }
    ).layerModel
    if (layerModel?.children) {
      for (const child of layerModel.children) {
        child?.resetClockBaselines?.(now)
      }
    }
  }
  for (const listener of clockBaselineResetListeners) {
    listener(now)
  }
}

export function resetStageTiming(app: App | object | undefined): void {
  if (!app) return
  resetClockBaselines(app)
}

export function recordLayoutRunningEnd(app: App | object, endMs: number): void {
  if (!Number.isFinite(endMs) || endMs <= 0) return
  const state = getState(app)
  state.layoutEndMs = Math.max(state.layoutEndMs, endMs)
}

export function getLayoutRunningEndMs(app: App | object): number {
  const state = stageTimingByApp.get(app)
  if (!state) return 0
  syncClockEpoch(state)
  return state.layoutEndMs
}

export function recordMotionSettledAt(app: App | object, modelId: number, endMs: number): void {
  if (!Number.isFinite(endMs) || endMs <= 0) return
  const state = getState(app)
  const prev = state.motionEndByModel.get(modelId) ?? 0
  state.motionEndByModel.set(modelId, Math.max(prev, endMs))
  const layerModel = (
    app as {
      layerModel?: { markMotionSettledAt?: (id: number, endMs: number) => void }
    }
  ).layerModel
  layerModel?.markMotionSettledAt?.(modelId, endMs)
}

export function getMotionSettledEndMs(app: App | object, now = nowMs()): number {
  const state = stageTimingByApp.get(app)
  if (!state) return 0
  syncClockEpoch(state, now)
  let maxEnd = 0
  for (const endMs of state.motionEndByModel.values()) {
    if (endMs > maxEnd) maxEnd = endMs
  }
  return maxEnd
}

export function areTrackedMotionsSettled(app: App | object, currentNowMs: number): boolean {
  const layerModel = (
    app as {
      layerModel?: { areMotionsSettled?: (nowMs: number) => boolean }
    }
  ).layerModel
  if (
    typeof layerModel?.areMotionsSettled === 'function' &&
    !layerModel.areMotionsSettled(currentNowMs)
  ) {
    return false
  }
  return currentNowMs >= getMotionSettledEndMs(app, currentNowMs) - 0.5
}

export interface ExtendedUILayer {
  UITalkShowed?: boolean
  resetTalkData?: () => void
  setTalkData?: (speaker: string, content: string) => void
  showTextBackground?: () => Promise<void>
  startDisplayContent?: (typingLength?: number) => Promise<void>
  hideTextBackground?: (durationMs?: number) => Promise<void>
  showPlaceInfo?: (text: string, durationMs?: number) => Promise<void>
  closePlaceInfo?: () => Promise<void> | void
  showFullScreenText?: (opts: {
    text: string
    durationMs?: number
    keepBars?: boolean
  }) => Promise<void>
  hideFullScreenText?: () => Promise<void>
  showChoiceDialog?: (choices: string[], pickedIndex?: number) => Promise<void>
  shakeWindow?: (durationSec: number, intensity?: number) => Promise<void>
  stopShakeWindow?: () => void
}

export interface ExtendedBackgroundLayer {
  setBackground?: (texture: unknown) => void
  changeBackground?: (imageOrUrl: unknown, durationMs?: number) => Promise<void> | void
  setBlur?: (enabled: boolean) => void
  setBackgroundBlur?: (active: boolean, level?: number, durationMs?: number) => Promise<void> | void
}

export interface ExtendedEnvironmentLayer {
  flashbackIn?: (duration: number, alpha: number) => Promise<void>
  flashbackOut?: (duration: number) => Promise<void>
  setFlashback?: (active: boolean, durationMs?: number) => Promise<void>
  setSepia?: (active: boolean, durationMs?: number) => Promise<void>
}

export interface ExtendedSpecialEffectLayer {
  playSekaiTransition?: (
    mode: 'In' | 'Out',
    durationMs: number,
    variant?: 'v1' | 'v2'
  ) => Promise<void>
  playSideFade?: (
    mode: 'In' | 'Out',
    direction: 'Left' | 'Right' | 'Top' | 'Bottom',
    durationMs: number
  ) => Promise<void>
  sideFade?: (
    edge: 'left' | 'right' | 'top' | 'bottom',
    mode: 'in' | 'out',
    duration: number
  ) => Promise<void>
  playScenarioEffect?: (name: string, delayMs?: number) => Promise<void> | void
  stopScenarioEffect?: (name: string, delayMs?: number) => Promise<void> | void
  setCameraBlur?: (active: boolean, durationMs: number) => Promise<void>
  playMovie?: (file: string, durationMs?: number) => Promise<void>
}

export interface ExtendedModelLayer {
  layoutMode: LayoutModes
  updateLayoutMode?: (mode: 'Normal' | 'Three') => void
  setLayoutDepth?: (modelId: number, depth: 'Front' | 'Back' | 'Reset') => void
  shakeCharacter?: (modelId: number, axis: 'X' | 'Y') => Promise<void>
  setCharacterShader?: (
    modelId: number,
    shader: 'hologram' | 'monitor' | 'blur' | 'none',
    level?: number
  ) => void
  changeCostume?: (modelId: number, costume: string) => Promise<void>
  resetAmbientColor?: () => void
  setAmbientColor?: (mode: 'normal' | 'evening' | 'night') => void
  markMotionSettledAt?: (modelId: number, endMs: number) => void
  areMotionsSettled?: (nowMs: number) => boolean
}

export interface ExtendedApp {
  cameraMove?: (x: number, y: number, durationMs: number, ease?: string) => Promise<void>
  cameraZoom?: (scale: number, durationMs: number, ease?: string) => Promise<void>
  dollyZoom?: (zoom: number, durationMs: number, ease?: string) => Promise<void>
  shakeScreen?: (durationSec: number, intensity?: number) => Promise<void>
  stopShakeScreen?: () => void
  stopShake?: () => void
  setOpeningCover?: (durationMs: number) => Promise<void>
  setEndingEnvelope?: (holdMs: number, fadeMs: number) => Promise<void>
}
