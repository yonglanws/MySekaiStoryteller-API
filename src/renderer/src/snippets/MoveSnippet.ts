import BaseSnippet from './BaseSnippet'
import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import AnimationManager from '../managers/AnimationManager'
import { MoveSpeed } from '../../../common/types/Story'
import {
  ExtendedModelLayer,
  nowMs,
  recordLayoutRunningEnd,
  recordMotionSettledAt
} from './stageTiming'

export default class MoveSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Move') return

    const model = this.app.getModelById(this.data.data.modelId)
    ;(this.app.layerModel as unknown as ExtendedModelLayer).setLayoutDepth?.(
      this.data.data.modelId,
      'Front'
    )

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

    if (this.data.data.motion || this.data.data.facial) {
      await model.startMotions(
        this.data.data.motion,
        this.data.data.facial,
        this.data.data.facialFirst ?? true,
        {
          facialForce: true,
          traceSnippetIndex: this.snippetIndex,
          preserveActiveShortBodyMotion: true
        }
      )
      if (this.data.data.motion && !model.isMotionLooping?.(this.data.data.motion)) {
        const clipMs = model.getMotionDurationMs?.(this.data.data.motion) ?? 0
        if (clipMs > 0) {
          recordMotionSettledAt(this.app, this.data.data.modelId, nowMs() + clipMs)
        }
      }
    }

    const moveMs =
      this.data.data.moveSpeed === MoveSpeed.Immediate
        ? 0
        : StageUtils.move_speed_to_num(this.data.data.moveSpeed)
    recordLayoutRunningEnd(this.app, nowMs() + moveMs)

    if (from.x === to.x && from.y === to.y) {
      // 官方 layout 片段按 CharacterMoveTo 的 duration 完成，即使位置没变也要等。
      model.setPositionRel(this.app.stage_size, to)
      if (moveMs > 0) await AnimationManager.delay(moveMs)
      return
    }

    if (this.data.data.moveSpeed === MoveSpeed.Immediate) {
      model.setPositionRel(this.app.stage_size, to)
      return
    }

    await model.move(this.app.stage_size, from, to, moveMs)
  }
}
