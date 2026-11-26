import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'
import {
  HIDE_DELAY_IN_PLACE_SMOOTH_MS,
  resolveCharacterFadeMs
} from '../../../common/official/timing'
import {
  type ExtendedModelLayer,
  nowMs,
  recordLayoutRunningEnd,
  recordMotionSettledAt
} from './stageTiming'

// noinspection DuplicatedCode
export default class LayoutClearSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'LayoutClear') return

    const model = this.app.getModelById(this.data.data.modelId)
    // 官方 HideCharacter：显示状态不是 Appear 时 OnFinished 立即触发。
    // 这里同时把逻辑状态置 false（不等后台淡出结束），与官方一致。
    const wasVisible = this.app.layerModel.markModelHidden
      ? this.app.layerModel.markModelHidden(this.data.data.modelId)
      : (this.app.layerModel.isModelVisible?.(this.data.data.modelId) ?? false)
    if (!wasVisible) {
      this.app.layerModel.removeModel(model)
      return
    }
    // 退场协程的代数：期间若有新的 Appear，本次淡出/清理必须整段作废。
    const visibilityToken = model.currentVisibilityGeneration?.()

    const from: PositionRel = StageUtils.side_to_position(
      this.data.data.from.side,
      this.app.layerModel.layoutMode,
      this.data.data.from.offset,
      this.data.data.from.under
    )
    const to: PositionRel = StageUtils.side_to_position(
      this.data.data.to.side,
      this.app.layerModel.layoutMode,
      this.data.data.to.offset,
      this.data.data.to.under
    )

    const isExporting = Boolean(AnimationManager.isExporting?.())
    const is_moved = from.x !== to.x || from.y !== to.y
    const fadeMs = resolveCharacterFadeMs(isExporting, AnimationManager.exportEncodeFPS, !is_moved)
    const move_duration_ms = is_moved ? StageUtils.move_speed_to_num(this.data.data.moveSpeed) : 0
    const inPlaceDelayMs = HIDE_DELAY_IN_PLACE_SMOOTH_MS
    const totalClearMs = is_moved ? Math.max(fadeMs, move_duration_ms) : inPlaceDelayMs + fadeMs
    const clearStartMs = nowMs()
    recordLayoutRunningEnd(this.app, clearStartMs + totalClearMs)

    // 退场动作先加载并启动；淡出只在最后 0.1s 发生，角色边演边走边隐。
    // 官方 `LayoutOp::Hide`（`sse-bake/src/lib.rs:2290-2296`）表情走正常 0.25s 交叉淡化，不强制 0s 硬切。
    const exit_motion = this.data.data.motion
    const exit_facial = this.data.data.facial
    if (exit_motion || exit_facial) {
      await model.startMotions(exit_motion || undefined, exit_facial || undefined, true, {
        facialForce: false,
        traceSnippetIndex: this.snippetIndex
      })
      if (exit_motion && !model.isMotionLooping?.(exit_motion)) {
        const clipMs = model.getMotionDurationMs?.(exit_motion) ?? 0
        if (clipMs > 0) {
          recordMotionSettledAt(this.app, this.data.data.modelId, clearStartMs + clipMs)
        }
      }
    }

    // SetTransformData(SideFrom) 先把角色放回起点；有位移时 `SetCharacterDepth(Front)`（不锁层级），再 CharacterMoveTo(SideTo)。
    model.setPositionRel(this.app.stage_size, is_moved ? from : to)
    if (is_moved) {
      const modelLayer = this.app.layerModel as unknown as ExtendedModelLayer
      modelLayer.bringToFront?.(this.data.data.modelId)
    }

    const move_task = is_moved
      ? model.move(this.app.stage_size, from, to, move_duration_ms, clearStartMs)
      : null

    // HideCharacter(id, delay)：
    // - 原地：0ms 前导 + 350ms（21 帧）平滑淡出；
    // - 滑动：delay = max(0, move_duration - 0.1s)，淡出结束时正好滑到位。
    const delay_ms = is_moved ? Math.max(0, move_duration_ms - fadeMs) : inPlaceDelayMs
    if (delay_ms > 0) {
      await AnimationManager.delay(delay_ms)
      if (visibilityToken !== undefined && !model.isVisibilityCurrent?.(visibilityToken)) return
    }
    // 淡出的起点仍是 act+delay：即使 delay 的 setTimeout 被帧泵取整到下一帧，
    // hide 也按绝对帧收尾，Clear 766.667ms 不会被记成 783ms。
    await model.hide(fadeMs, visibilityToken, clearStartMs + delay_ms)
    if (visibilityToken !== undefined && !model.isVisibilityCurrent?.(visibilityToken)) return
    if (move_task) await move_task
    if (visibilityToken !== undefined && !model.isVisibilityCurrent?.(visibilityToken)) return

    // 动画全部结束后再移出渲染层；提前移除会导致淡出/滑出不可见（硬切消失）
    this.app.layerModel.removeModel(model)
  }
}
