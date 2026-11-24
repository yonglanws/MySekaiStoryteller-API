import AnimationManager from '../managers/AnimationManager'
import { exportLogBus } from '../managers/video-export/ExportLogBus'

/**
 * 导出探针：只在导出模式写入 `<video>.log.json`，预览完全不产生日志。
 * 特效几何/分段参数写进这里，供像素对比时反演当前实现的实际参数。
 */
export function recordEffectProbe(message: string, data: unknown): void {
  if (typeof AnimationManager.isExporting !== 'function' || !AnimationManager.isExporting()) {
    return
  }
  exportLogBus.record('INFO', 'EffectProbe', message, data)
}
