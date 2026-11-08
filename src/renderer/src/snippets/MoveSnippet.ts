import BaseSnippet from './BaseSnippet'
import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import AnimationManager from '../managers/AnimationManager'
import { MoveSpeed } from '../../../common/types/Story'

export default class MoveSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Move') return

    const model = this.app.getModelById(this.data.data.modelId)
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

    // PJSK CharacterLayout/Motion：动作与位移并发。这里只等位移转场结束，
    // 不等完整动作剪辑（body motion 平均 2.3s）——旧实现会让每个 Move 停顿
    // 1~4 秒，是“动作切换忽快忽慢”的另一来源。
    if (this.data.data.motion || this.data.data.facial) {
      await model.startMotions(
        this.data.data.motion,
        this.data.data.facial,
        this.data.data.facialFirst,
        { facialForce: true, traceSnippetIndex: this.snippetIndex }
      )
    }

    let move_task: Promise<void> | null = null

    if (from.x === to.x && from.y === to.y) {
      // 官方 layout 片段按 CharacterMoveTo 的 duration 完成，即使位置没变也要等。
      model.setPositionRel(this.app.stage_size, to)
      const moveMs =
        this.data.data.moveSpeed === MoveSpeed.Immediate
          ? 0
          : StageUtils.move_speed_to_num(this.data.data.moveSpeed)
      if (moveMs > 0) await AnimationManager.delay(moveMs)
      return
    }

    if (this.data.data.moveSpeed === MoveSpeed.Immediate) {
      move_task = Promise.resolve(model.setPositionRel(this.app.stage_size, to))
    } else {
      move_task = model.move(
        this.app.stage_size,
        from,
        to,
        StageUtils.move_speed_to_num(this.data.data.moveSpeed)
      )
    }

    await move_task
  }
}
