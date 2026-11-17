import { LayoutModes, MoveSpeed, Sides, type LayoutSide } from '../../../common/types/Story'
import Position_rel from '../types/PositionRel'
import {
  LAYOUT_REFERENCE_WIDTH,
  MODE_SCALE_DEFAULT,
  MODE_SCALE_THREE,
  MOVE_DURATION_FAST_MS,
  MOVE_DURATION_NORMAL_MS,
  MOVE_DURATION_SLOW_MS,
  SIDE_OVER_X,
  SIDE_UNDER_Y,
  SIDE_X_DEFAULT,
  SIDE_X_THREE
} from '../../../common/official/timing'

export const LAYOUT_REFERENCE_HEIGHT = 1080
export { SIDE_OVER_X, SIDE_UNDER_Y }

export default class StageUtils {
  public static modeScale(layout_mode: LayoutModes | string): number {
    return layout_mode === LayoutModes.Three || layout_mode === 'Three'
      ? MODE_SCALE_THREE
      : MODE_SCALE_DEFAULT
  }

  public static side_to_position(
    side: LayoutSide | Sides | string,
    layout_mode: LayoutModes | string,
    offset: number,
    under?: boolean
  ): Position_rel {
    // 官方 layout.transform_map：普通 ±350、三人 ±550、Over ±1779.2（参考宽 1920），Under 向下移出画外。
    const sideX =
      layout_mode === LayoutModes.Three || layout_mode === 'Three' ? SIDE_X_THREE : SIDE_X_DEFAULT
    const sideStr = String(side)
    let xPx = 0
    if (sideStr === Sides.LeftOver) {
      xPx = -SIDE_OVER_X
    } else if (sideStr === Sides.RightOver) {
      xPx = SIDE_OVER_X
    } else if (sideStr === Sides.Left || sideStr === 'LeftInside' || sideStr === 'LeftUnder' || sideStr === 'LeftInsideUnder') {
      xPx = -sideX
    } else if (sideStr === Sides.Right || sideStr === 'RightInside' || sideStr === 'RightUnder' || sideStr === 'RightInsideUnder') {
      xPx = sideX
    }

    const isUnder = under === true || sideStr === Sides.Under || /Under$/i.test(sideStr)
    return {
      x: 0.5 + (xPx + offset) / LAYOUT_REFERENCE_WIDTH,
      y: isUnder ? 0.5 + Math.abs(SIDE_UNDER_Y) / LAYOUT_REFERENCE_HEIGHT : 0.5
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
