/**
 * 官方 `PostEffectType` 是单个枚举（`sse-bake/src/lib.rs:2704-2726`）：
 * Sepia/Flashback 写 Color，Blur 写 Blur，各自的 off/Out 完成写 None。
 * Color 与 Blur 不能同时叠加；Blur 的 setter 在 tween 期间每帧写 Blur，
 * 所以 blur 活动时后到的 color 也不能抢槽。
 */
export type PostEffectOwner = 'none' | 'color' | 'blur'
export type PostEffectEvent =
  | 'color-filters'
  | 'no-color-filters'
  | 'blur-filter'
  | 'no-blur-filter'

export function nextPostEffectOwner(
  owner: PostEffectOwner,
  event: PostEffectEvent,
  blurPresent: boolean
): PostEffectOwner {
  switch (event) {
    case 'blur-filter':
      return 'blur'
    case 'no-blur-filter':
      return owner === 'blur' ? 'none' : owner
    case 'no-color-filters':
      // `CameraColorOff` (SepiaOut/FlashbackOut) 无条件写 None，连残留的 blur 一起结束；
      // blur tween 仍在跑时，下一帧的 setter 会重新写 Blur（与参考同帧序）。
      return 'none'
    case 'color-filters':
      return owner === 'blur' && blurPresent ? 'blur' : 'color'
  }
}
