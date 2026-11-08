import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'
import { CHARACTER_FADE_MS, HIDE_DELAY_IN_PLACE_MS } from '../../../common/official/timing'

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
      this.data.data.from.offset
    )
    const to: PositionRel = StageUtils.side_to_position(
      this.data.data.to.side,
      this.app.layerModel.layoutMode,
      this.data.data.to.offset
    )

    const is_moved = from.x !== to.x || from.y !== to.y
    const move_duration_ms = is_moved ? StageUtils.move_speed_to_num(this.data.data.moveSpeed) : 0

    // 退场动作先加载并启动；淡出只在最后 0.1s 发生，角色边演边走边隐。
    const exit_motion = this.data.data.motion
    const exit_facial = this.data.data.facial
    if (exit_motion || exit_facial) {
      await model.startMotions(exit_motion || undefined, exit_facial || undefined, true, {
        facialForce: true,
        traceSnippetIndex: this.snippetIndex
      })
    }

    // SetTransformData(SideFrom) 先把角色放回起点，再 CharacterMoveTo(SideTo)。
    model.setPositionRel(this.app.stage_size, is_moved ? from : to)

    const move_task = is_moved ? model.move(this.app.stage_size, from, to, move_duration_ms) : null

    // HideCharacter(id, delay)：
    // - 原地：delay 0.15s，然后 0.1s 淡出，共 0.25s；
    // - 滑动：delay = move_duration - 0.1s，淡出结束时正好滑到位。
    const delay_ms = is_moved
      ? Math.max(0, move_duration_ms - CHARACTER_FADE_MS)
      : HIDE_DELAY_IN_PLACE_MS
    if (delay_ms > 0) {
      await AnimationManager.delay(delay_ms)
      if (visibilityToken !== undefined && !model.isVisibilityCurrent?.(visibilityToken)) return
    }
    await model.hide(CHARACTER_FADE_MS, visibilityToken)
    if (visibilityToken !== undefined && !model.isVisibilityCurrent?.(visibilityToken)) return
    if (move_task) await move_task
    if (visibilityToken !== undefined && !model.isVisibilityCurrent?.(visibilityToken)) return

    // 动画全部结束后再移出渲染层；提前移除会导致淡出/滑出不可见（硬切消失）
    this.app.layerModel.removeModel(model)
  }
}
