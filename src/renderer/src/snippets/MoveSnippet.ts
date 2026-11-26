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
    const moveStartMs = nowMs()
    // 官方 `LayoutOp::Move`（`sse-bake/src/lib.rs:2091`）只调用 `SetCharacterDepth(id, Front)`
    // 而不调用 `LockCharacterDepth`；若误调 `setLayoutDepth('Front')` 会永久锁死首个移动角色在最前。
    const modelLayer = this.app.layerModel as unknown as ExtendedModelLayer
    if (typeof modelLayer.bringToFront === 'function') {
      modelLayer.bringToFront(this.data.data.modelId)
    } else {
      modelLayer.setLayoutDepth?.(this.data.data.modelId, 'Front')
    }

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
      // 官方 `LayoutOp::Move`（`sse-bake/src/lib.rs:2290-2296`）表情走正常 0.25s 交叉淡化，
      // 避免静默反应拍（原地 Move）的表情 1 帧硬切。
      await model.startMotions(
        this.data.data.motion,
        this.data.data.facial,
        this.data.data.facialFirst ?? true,
        {
          facialForce: false,
          traceSnippetIndex: this.snippetIndex
        }
      )
      if (this.data.data.motion && !model.isMotionLooping?.(this.data.data.motion)) {
        const clipMs = model.getMotionDurationMs?.(this.data.data.motion) ?? 0
        if (clipMs > 0) {
          recordMotionSettledAt(this.app, this.data.data.modelId, moveStartMs + clipMs)
        }
      }
    }

    const moveMs =
      this.data.data.moveSpeed === MoveSpeed.Immediate
        ? 0
        : StageUtils.move_speed_to_num(this.data.data.moveSpeed)
    recordLayoutRunningEnd(this.app, moveStartMs + moveMs)

    if (moveMs === 0) {
      model.setPositionRel(this.app.stage_size, to)
      return
    }

    // 官方 `move_view` 从当前 x/y 起步，而不是 snippet 里的 from；
    // 同一帧的 LayoutAppear 可能已把角色放到 to，此时 Move 是 0 位移但仍等满 duration。
    const moveToCurrent = (
      model as unknown as {
        moveToCurrent?: (
          stage: [number, number],
          to: PositionRel,
          ms: number,
          start?: number
        ) => Promise<boolean>
      }
    ).moveToCurrent
    if (typeof moveToCurrent === 'function') {
      const moved = await moveToCurrent.call(model, this.app.stage_size, to, moveMs, moveStartMs)
      if (!moved) await AnimationManager.delay(moveMs)
      return
    }

    if (from.x === to.x && from.y === to.y) {
      model.setPositionRel(this.app.stage_size, to)
      await AnimationManager.delay(moveMs)
      return
    }
    await model.move(this.app.stage_size, from, to, moveMs, moveStartMs)
  }
}
