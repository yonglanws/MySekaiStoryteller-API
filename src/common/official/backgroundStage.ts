/**
 * 官方背景层：`sse-render/src/lib.rs:668-685` 把背景贴图铺进固定的
 * 2338×1440 `BACKGROUND_BASE_SIZE` 矩形，而不是按图片自身像素 cover。
 * 1920×1080 内容下 scale=1，矩形四周各裁 209/180px；较 MSST 旧的
 * texture-cover 放大约 1.218×（跨渲染器配准峰值 s≈1.22）。
 */
export const BACKGROUND_BASE_SIZE = [2338, 1440] as const

/** 参考的 content 尺寸（布局/背景的 1920×1080 基准）。 */
export function backgroundBaseScale(contentWidth: number, contentHeight: number): number {
  const [bw, bh] = BACKGROUND_BASE_SIZE
  const dx = contentWidth - bw
  const dy = contentHeight - bh
  if (dx <= 0 && dy <= 0) return 1
  if (dx <= 0) return contentHeight / bh
  if (dy <= 0) return contentWidth / bw
  return Math.max(contentWidth / bw, contentHeight / bh)
}

export interface BackgroundStageRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 目标画布（逻辑像素）里的居中背景矩形；`k = screenWidth / 1920`，
 * 与参考 `bg_rect = [(w-bw·s·k)/2, (h-bh·s·k)/2, bw·s·k, bh·s·k]` 一致。
 */
export function backgroundStageRect(
  screenWidth: number,
  screenHeight: number,
  contentWidth = 1920,
  contentHeight = 1080
): BackgroundStageRect {
  const scale = backgroundBaseScale(contentWidth, contentHeight)
  const k = contentWidth > 0 ? screenWidth / contentWidth : 1
  const width = BACKGROUND_BASE_SIZE[0] * scale * k
  const height = BACKGROUND_BASE_SIZE[1] * scale * k
  return {
    x: (screenWidth - width) * 0.5,
    y: (screenHeight - height) * 0.5,
    width,
    height
  }
}
