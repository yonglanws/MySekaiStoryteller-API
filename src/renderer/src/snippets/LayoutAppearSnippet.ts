import PositionRel from '../types/PositionRel'
import StageUtils from '../utils/StageUtils'
import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'
import {
  APPEAR_FADE_TOTAL_FRAMES,
  APPEAR_SHOWN_MOVE_MS,
  CHARACTER_FADE_MS,
  FRAME_MS,
  framesForSeconds,
  resolveCharacterFadeMs
} from '../../../common/official/timing'
import { nowMs, recordLayoutRunningEnd, recordMotionSettledAt } from './stageTiming'

// noinspection DuplicatedCode
export default class LayoutAppearSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'LayoutAppear') return

    const model = this.app.getModelById(this.data.data.modelId)
    const appearStartMs = nowMs()
    // 官方显示状态才是 Appear 分支的依据：后台还没淡完的 HideCharacter 已经
    // 把 shown 置 false，此时 Appear 必须是 7 帧淡入，而不是按 alpha 走 0.2s 移动。
    const wasShown = this.app.layerModel.markModelShown
      ? this.app.layerModel.markModelShown(this.data.data.modelId)
      : (this.app.layerModel.isModelVisible?.(this.data.data.modelId) ?? false)
    // 新 Appear 让所有更早的退场协程失效（停止写 alpha / 清理动作 / removeModel）。
    const visibilityToken = model.beginVisibilityChange?.()

    this.app.layerModel.addModelToLayer(model)

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
    const is_moved = from.x !== to.x || from.y !== to.y
    // 新 view 在 act 帧就落到 SideFrom（参考 `CharacterRt::new` 的 x/y 初值），
    // 必须早于动作 await，否则同帧的 Move 会从旧位置起步。
    if (!wasShown) model.setPositionRel(this.app.stage_size, is_moved ? from : to)

    // 确保模型内部已完全初始化
    if (!model.internalModel) {
      this.logger.warn('Model internalModel not ready, waiting...')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    // 先把动作真正启动（此时模型 alpha=0，观众看不到），再开始淡入/滑入。
    const entryMotion =
      this.data.data.motion && model.hasMotion(this.data.data.motion) ? this.data.data.motion : ''
    if (entryMotion || this.data.data.facial) {
      await model.startMotions(
        entryMotion,
        this.data.data.facial,
        this.data.data.facialFirst ?? true,
        {
          facialForce: true,
          traceSnippetIndex: this.snippetIndex
        }
      )
      if (entryMotion && !model.isMotionLooping?.(entryMotion)) {
        const clipMs = model.getMotionDurationMs?.(entryMotion) ?? 0
        if (clipMs > 0) {
          recordMotionSettledAt(this.app, this.data.data.modelId, appearStartMs + clipMs)
        }
      }
    }
    if (!entryMotion) {
      await model.startEntryMotion(!this.data.data.facial, this.snippetIndex)
    }

    if (wasShown) {
      // 官方 AppearCharacter 对已在场的 view 走 CharacterMoveToCoroutine(side, 0.2)：
      // 不淡入，片段等这 0.2s 的滑动完成。move_view 从当前 x/y 起步。
      recordLayoutRunningEnd(this.app, appearStartMs + APPEAR_SHOWN_MOVE_MS)
      model.setOpacity?.(1)
      const moveToCurrent = (
        model as unknown as {
          moveToCurrent?: (stage: [number, number], to: PositionRel, ms: number) => Promise<boolean>
        }
      ).moveToCurrent
      if (typeof moveToCurrent === 'function') {
        const moved = await moveToCurrent.call(model, this.app.stage_size, to, APPEAR_SHOWN_MOVE_MS)
        if (!moved) await AnimationManager.delay(APPEAR_SHOWN_MOVE_MS)
      } else {
        model.setPositionRel(this.app.stage_size, from)
        if (is_moved) {
          await model.move(this.app.stage_size, from, to, APPEAR_SHOWN_MOVE_MS)
        } else {
          await AnimationManager.delay(APPEAR_SHOWN_MOVE_MS)
        }
      }
      model.startBodyIdleLoop()
      return
    }

    // 新 view：AppearCharacter(SideFrom) 先落到 from（已在 act 帧设置），
    // CharacterMoveTo(SideTo) 与淡入并发，片段只等淡入（滑入继续在后台）。

    const isExporting = Boolean(AnimationManager.isExporting?.())
    const fadeMs = resolveCharacterFadeMs(isExporting, AnimationManager.exportEncodeFPS)
    const moveMs = is_moved ? StageUtils.move_speed_to_num(this.data.data.moveSpeed) : 0
    // 官方 `at = frame + (hidden && motion)`：带 motion 的新角色，类型分支（淡入/滑入）
    // 延后一帧；动作本身仍在 act 启动。
    const branchDelayMs = entryMotion ? FRAME_MS : 0
    const holdFrames = Math.max(
      0,
      APPEAR_FADE_TOTAL_FRAMES - framesForSeconds(CHARACTER_FADE_MS / 1000)
    )
    const fadeTotalMs = holdFrames * FRAME_MS + fadeMs
    // Talk 的布局门只等片段本身（淡入结束）；后台滑入不阻塞下一句
    // （参考 `layout_running` 只看片段，`motions_settled` 只看 body motion）。
    recordLayoutRunningEnd(this.app, appearStartMs + branchDelayMs + fadeTotalMs)

    if (branchDelayMs > 0) await AnimationManager.delay(branchDelayMs)
    const moveTask = is_moved ? model.move(this.app.stage_size, from, to, moveMs) : null
    if (moveTask) {
      // 官方交互与导出都只等淡入 7 帧，滑入继续在后台推进。
      void moveTask.catch((error) => this.logger.warn('LayoutAppear move failed', error))
    }

    // FadeOpacityCoroutine：WaitForSeconds(0) 至少 1 帧，alpha 保持 0；然后淡入 100ms。
    if (holdFrames > 0) await AnimationManager.delay(holdFrames * FRAME_MS)
    await model.show(fadeMs, this.data.data.hologram, visibilityToken)

    // 入场动作继续播放；body 通道交给 idle 续演逻辑，台词间隙不站桩。
    model.startBodyIdleLoop()
  }
}
