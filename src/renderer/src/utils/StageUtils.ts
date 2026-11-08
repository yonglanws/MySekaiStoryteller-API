import { LayoutModes, MoveSpeed, Sides } from '../../../common/types/Story'
import Position_rel from '../types/PositionRel'
import {
  LAYOUT_REFERENCE_WIDTH,
  MOVE_DURATION_FAST_MS,
  MOVE_DURATION_NORMAL_MS,
  MOVE_DURATION_SLOW_MS,
  SIDE_X_DEFAULT,
  SIDE_X_THREE
} from '../../../common/official/timing'

export default class StageUtils {
  public static side_to_position(
    side: Sides,
    layout_mode: LayoutModes,
    offset: number
  ): Position_rel {
    // 官方 layout.transform_map：普通 ±350、三人 ±550（参考像素，舞台宽 1920）。
    const sideX = layout_mode === LayoutModes.Three ? SIDE_X_THREE : SIDE_X_DEFAULT
    const direction = side === Sides.Left ? -1 : side === Sides.Right ? 1 : 0
    return {
      x: 0.5 + (direction * sideX + offset) / LAYOUT_REFERENCE_WIDTH,
      y: 0.5
    }
  }

  public static move_speed_to_num(move_speed: MoveSpeed): number {
    return {
      [MoveSpeed.Slow]: MOVE_DURATION_SLOW_MS,
      [MoveSpeed.Normal]: MOVE_DURATION_NORMAL_MS,
      [MoveSpeed.Fast]: MOVE_DURATION_FAST_MS,
      [MoveSpeed.Immediate]: 0
    }[move_speed]
  }
}
