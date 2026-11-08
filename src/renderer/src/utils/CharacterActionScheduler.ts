import type { CharacterAction } from '../../../common/types/Story'

export interface CharacterActionTarget {
  isVisible: (modelId: number) => boolean
  /** Resolves once the motion has started, not when the clip has finished. */
  apply: (action: CharacterAction, signal: AbortSignal) => void | Promise<void>
  onError?: (error: unknown, action: CharacterAction) => void
}

export interface CharacterActionSchedule {
  /** The cue timeline has ended (or was cancelled); does not wait for motion clips. */
  finished: Promise<void>
  /** Clear remaining cues and invalidate any in-flight motion loads. */
  cancel: () => void
}

/**
 * Run character cues on the containing snippet's clock, without blocking dialogue.
 * Standard timers/performance.now are also driven by the fast export virtual clock.
 * Call cancel in the snippet's finally block, and pass its export/lifecycle signal.
 */
export function scheduleCharacterActions(
  actions: readonly CharacterAction[],
  durationMs: number,
  target: CharacterActionTarget,
  signal?: AbortSignal
): CharacterActionSchedule {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError('Character action duration must be finite and non-negative')
  }
  for (const action of actions) {
    if (!Number.isFinite(action.at) || action.at < 0 || action.at > 1) {
      throw new RangeError('Character action at must be a fraction between 0 and 1')
    }
  }
  const ordered = actions
    .map((action, index) => ({ action, index }))
    .sort((a, b) => a.action.at - b.action.at || a.index - b.index)
  const controller = new AbortController()
  const startedAt = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cursor = 0
  let settled = false
  let finishing = false
  let finishWatchdog: ReturnType<typeof setTimeout> | undefined
  let resolveFinished!: () => void
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve
  })

  const settle = (): void => {
    if (settled) return
    if (finishWatchdog !== undefined) clearTimeout(finishWatchdog)
    finishWatchdog = undefined
    signal?.removeEventListener('abort', cancel)
    settled = true
    resolveFinished()
  }
  const finish = (finalStarts: Promise<void>[] = []): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (settled) return
    if (finalStarts.length > 0 && !finishing) {
      finishing = true
      finishWatchdog = setTimeout(() => {
        controller.abort()
        settle()
      }, 5000)
      Promise.all(finalStarts).finally(settle)
      return
    }
    settle()
  }
  const cancel = (): void => {
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    settle()
  }
  const finalStarts: Promise<void>[] = []
  const dispatch = (action: CharacterAction): void => {
    if (controller.signal.aborted || !target.isVisible(action.modelId)) return
    try {
      const started = Promise.resolve(target.apply(action, controller.signal)).catch((error) => {
        if (!controller.signal.aborted) target.onError?.(error, action)
      })
      // 等所有 cue 的“启动”Promise，而不只是 at=1。动作加载是异步的；如果
      // 片段时长只有几毫秒（官方 ChangeMotion cue），提前 settle 会让调用方
      // 的 cancel() 在 startMotion 之前 abort 掉信号，动作就永远不播。
      finalStarts.push(started)
    } catch (error) {
      target.onError?.(error, action)
    }
  }
  const step = (): void => {
    if (controller.signal.aborted) return
    const elapsed = Math.max(0, performance.now() - startedAt)
    while (cursor < ordered.length && ordered[cursor].action.at * durationMs <= elapsed) {
      dispatch(ordered[cursor++].action)
      if (controller.signal.aborted) return
    }
    if (elapsed >= durationMs) {
      finish(finalStarts)
      return
    }
    const nextAt = cursor < ordered.length ? ordered[cursor].action.at * durationMs : durationMs
    timer = setTimeout(step, Math.max(1, Math.min(nextAt, durationMs) - elapsed))
  }

  if (signal?.aborted) {
    cancel()
  } else {
    signal?.addEventListener('abort', cancel, { once: true })
    step()
  }
  return { finished, cancel }
}
