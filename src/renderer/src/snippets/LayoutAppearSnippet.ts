import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'
import {
  APPEAR_FADE_TOTAL_FRAMES,
  APPEAR_SHOWN_MOVE_MS,
  CHARACTER_FADE_MS,
  FRAME_MS,
  framesForSeconds
} from '../../../common/official/timing'

// noinspection DuplicatedCode
export default class LayoutAppearSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'LayoutAppear') return

    const model = this.app.getModelById(this.data.data.modelId)
    // 官方显示状态才是 Appear 分支的依据：后台还没淡完的 HideCharacter 已经
    // 把 shown 置 false，此时 Appear 必须是 7 帧淡入，而不是按 alpha 走 0.2s 移动。
    const wasShown = this.app.layerModel.markModelShown
      ? this.app.layerModel.markModelShown(this.data.data.modelId)
      : (this.app.layerModel.isModelVisible?.(this.data.data.modelId) ?? false)
    // 新 Appear 让所有更早的退场协程失效（停止写 alpha / 清理动作 / removeModel）。
    const visibilityToken = model.beginVisibilityChange?.()

    this.app.layerModel.addModelToLayer(model)

    // 确保模型内部已完全初始化
    if (!model.internalModel) {
      this.logger.warn('Model internalModel not ready, waiting...')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

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

    // 先把动作真正启动（此时模型 alpha=0，观众看不到），再开始淡入/滑入。
    // 旧顺序先 show 再 await startMotions：动作文件冷加载期间角色已经淡入但仍是站姿，
    // 这就是“入场一瞬间站桩”的直接来源。
    const entryMotion =
      this.data.data.motion && model.hasMotion(this.data.data.motion) ? this.data.data.motion : ''
    if (entryMotion || this.data.data.facial) {
      await model.startMotions(entryMotion, this.data.data.facial, this.data.data.facialFirst, {
        facialForce: true,
        traceSnippetIndex: this.snippetIndex
      })
    }
    if (!entryMotion) {
      // 外部直接导出的剧本可能没写、或写了别的模型的动作；兜底也要边动边出现。
      // 剧本已给合法表情时保留它，不要被默认表情覆盖。
      await model.startEntryMotion(!this.data.data.facial, this.snippetIndex)
    }

    if (wasShown) {
      // 官方 AppearCharacter 对已在场的 view 走 CharacterMoveToCoroutine(side, 0.2)：
      // 不淡入，片段等这 0.2s 的滑动完成。
      model.setOpacity?.(1)
      model.setPositionRel(this.app.stage_size, from)
      if (is_moved) {
        await model.move(this.app.stage_size, from, to, APPEAR_SHOWN_MOVE_MS)
      } else {
        await AnimationManager.delay(APPEAR_SHOWN_MOVE_MS)
      }
      model.startBodyIdleLoop()
      return
    }

    // 新 view：AppearCharacter(SideFrom) 先落到 from，CharacterMoveTo(SideTo) 与淡入并发。
    model.setPositionRel(this.app.stage_size, is_moved ? from : to)

    const moveTask = is_moved
      ? model.move(
          this.app.stage_size,
          from,
          to,
          StageUtils.move_speed_to_num(this.data.data.moveSpeed)
        )
      : null
    if (moveTask) {
      // 官方 Appear 片段只等淡入（7 帧），滑入继续在后台播放；不能 await 完整 move。
      void moveTask.catch((error) => this.logger.warn('LayoutAppear move failed', error))
    }

    // FadeOpacityCoroutine：WaitForSeconds(0) 至少 1 帧，alpha 保持 0；然后 0.1s 淡入。
    const holdFrames = Math.max(
      0,
      APPEAR_FADE_TOTAL_FRAMES - framesForSeconds(CHARACTER_FADE_MS / 1000)
    )
    if (holdFrames > 0) await AnimationManager.delay(holdFrames * FRAME_MS)
    await model.show(CHARACTER_FADE_MS, this.data.data.hologram, visibilityToken)

    // 入场动作继续播放；body 通道交给 idle 续演逻辑，台词间隙不站桩。
    model.startBodyIdleLoop()
  }
}
