/**
 * 官方 `Live2DRenderStudio` 的 Live2D 取景常量（参考 `sse-render/src/gpu.rs:1140-1155`）。
 *
 * 角色先渲染进 2304×1536 的 RT：正交相机 orthographicSize=1.5、standScale=2.8，
 * 模型站在 world y = fixedStageY×ortho + standY = -1.117，即 RT 底部上方
 * `(0.383/3)×1536 = 196.1px`。合成到屏幕时 RT 高 `contentH×1536/1024`，
 * 所以模型画布中心（Cubism 原点）落在 `contentH - rtH×(0.383/3)`。
 */
export const LIVE2D_ORTHO_SIZE = 1.5
export const LIVE2D_FIXED_STAGE_Y = -1
export const LIVE2D_STAND_Y = 0.383
export const LIVE2D_STAND_SCALE = 2.8
export const LIVE2D_SCALE_REFERENCE_HEIGHT = 1024

/** `live2d.render_texture_size`。 */
export const LIVE2D_RT_SIZE = [2304, 1536] as const

const MODEL_ORIGIN_FROM_RT_BOTTOM =
  (LIVE2D_FIXED_STAGE_Y * LIVE2D_ORTHO_SIZE + LIVE2D_STAND_Y + LIVE2D_ORTHO_SIZE) /
  (LIVE2D_ORTHO_SIZE * 2)

/** 模型画布中心在屏幕上的 y（content 像素，top-left 原点）。 */
export function live2dCharacterOriginY(contentHeight: number, modeScale = 1): number {
  const rtHeight = contentHeight * (LIVE2D_RT_SIZE[1] / LIVE2D_SCALE_REFERENCE_HEIGHT) * modeScale
  return contentHeight - rtHeight * MODEL_ORIGIN_FROM_RT_BOTTOM
}
