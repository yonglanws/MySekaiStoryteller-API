import { Application, Container, Sprite, Texture, Ticker, type Filter } from 'pixi.js'
import BaseLayer from './BaseLayer'
import ui_se_black from '../../assets/ui/ui_se_black.svg'
import SEBlack from '../components/SEBlack'
import AnimationManager from '../managers/AnimationManager'
import { runEasedTween } from '../effects/Ease'
import { inappUrl, loadInappTexture } from '../effects/InappTextures'
import { CameraBlurFilter } from '../effects/OfficialFilters'
import { ScenarioEffectOverlay, SekaiTransitionParticles } from '../effects/TriangleParticleEffect'
import {
  FRAME_MS,
  SEKAI_IN_FADE_DELAY_MS,
  SEKAI_OUT_FADE_DELAY_MS,
  msToFrameCount
} from '../../../common/official/timing'

function isTextureUsable(tex: Texture | null | undefined): tex is Texture {
  return Boolean(tex && tex.valid && tex.baseTexture && tex.baseTexture.valid)
}

function buildSolidColorTexture(color: string): Texture {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 4
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 4, 4)
      return Texture.from(canvas)
    }
  }
  return Texture.EMPTY
}

export type SideFadeDirection =
  | 'Left'
  | 'Right'
  | 'Top'
  | 'Bottom'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'

function buildFeatheredSideFadeTexture(
  w: number,
  h: number,
  feather: number,
  horizontal: boolean,
  featherSide: 'start' | 'end'
): Texture {
  if (typeof document === 'undefined') {
    return Texture.from(ui_se_black)
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(horizontal ? w + feather : w))
  canvas.height = Math.max(2, Math.round(horizontal ? h : h + feather))
  const ctx = canvas.getContext('2d')
  if (!ctx) return Texture.from(ui_se_black)

  if (horizontal) {
    const grad =
      featherSide === 'end'
        ? ctx.createLinearGradient(w, 0, w + feather, 0)
        : ctx.createLinearGradient(0, 0, feather, 0)
    if (featherSide === 'end') {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, w, h)
      grad.addColorStop(0, 'rgba(0,0,0,1)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(w, 0, feather, h)
    } else {
      grad.addColorStop(0, 'rgba(0,0,0,0)')
      grad.addColorStop(1, 'rgba(0,0,0,1)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, feather, h)
      ctx.fillStyle = '#000000'
      ctx.fillRect(feather, 0, w, h)
    }
  } else {
    const grad =
      featherSide === 'end'
        ? ctx.createLinearGradient(0, h, 0, h + feather)
        : ctx.createLinearGradient(0, 0, 0, feather)
    if (featherSide === 'end') {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, w, h)
      grad.addColorStop(0, 'rgba(0,0,0,1)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, h, w, feather)
    } else {
      grad.addColorStop(0, 'rgba(0,0,0,0)')
      grad.addColorStop(1, 'rgba(0,0,0,1)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, feather)
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, feather, w, h)
    }
  }
  return Texture.from(canvas)
}

/** 全屏转场、SideFade 羽化遮罩、SekaiTransition、相机模糊、剧情粒子与视频播放层。 */
export default class SpecialEffectLayer extends BaseLayer {
  private readonly seBlackSprite: SEBlack
  private readonly seWhiteSprite: SEBlack
  private readonly wipeSprite: Sprite
  private readonly fxContainer: Container
  private readonly movieSprite: Sprite
  private readonly cameraBlurFilter = new CameraBlurFilter(0)
  private readonly activeTransitions = new Set<SekaiTransitionParticles>()
  private readonly activeScenarioEffects: ScenarioEffectOverlay[] = []
  private readonly sideFadeTextures = new Map<string, Texture>()
  private tickerAttached = false
  private cameraBlurGen = 0
  private fadeGen = 0
  private sideFadeGen = 0
  private isExportMode = false
  private filterSyncCallback: ((filter: Filter | null) => void) | null = null

  constructor(app: Application) {
    super(app, 3)
    this.layerContainer.sortableChildren = true

    const rawBlack = Texture.from(ui_se_black)
    const sfBlackTexture = isTextureUsable(rawBlack) ? rawBlack : buildSolidColorTexture('#000000')
    const whiteTexture = isTextureUsable(Texture.WHITE)
      ? Texture.WHITE
      : buildSolidColorTexture('#ffffff')
    this.seBlackSprite = new SEBlack(sfBlackTexture, this.app.screen.width, this.app.screen.height)
    this.seWhiteSprite = new SEBlack(whiteTexture, this.app.screen.width, this.app.screen.height)
    this.seWhiteSprite.visible = false

    this.wipeSprite = new Sprite(sfBlackTexture)
    this.wipeSprite.anchor.set(0)
    this.wipeSprite.width = this.app.screen.width
    this.wipeSprite.height = this.app.screen.height
    this.wipeSprite.visible = false

    this.fxContainer = new Container()
    this.fxContainer.zIndex = 1

    this.movieSprite = new Sprite()
    this.movieSprite.anchor.set(0.5)
    this.movieSprite.position.set(this.app.screen.width / 2, this.app.screen.height / 2)
    this.movieSprite.visible = false
    this.movieSprite.zIndex = 2

    this.seBlackSprite.zIndex = 3
    this.seWhiteSprite.zIndex = 4
    this.wipeSprite.zIndex = 5

    this.layerContainer.addChild(
      this.fxContainer,
      this.movieSprite,
      this.seBlackSprite,
      this.seWhiteSprite,
      this.wipeSprite
    )

    void loadInappTexture('player/loose/Texture2D/tex_transition_left.png')
    void loadInappTexture('player/loose/Texture2D/tex_transition_top.png')
  }

  public getContainer(): Container {
    return this.layerContainer
  }

  public setExportMode(exporting: boolean): void {
    this.isExportMode = exporting
  }

  public setCameraBlurCallback(cb: ((filter: Filter | null) => void) | null): void {
    this.filterSyncCallback = cb
  }

  public getCameraBlurFilter(): CameraBlurFilter | null {
    return this.cameraBlurFilter.spread > 0.001 ? this.cameraBlurFilter : null
  }

  private ensureTicker(): void {
    if (this.tickerAttached) return
    this.tickerAttached = true
    Ticker.shared.add(this.stepEffects, this)
  }

  private stepEffects = (): void => {
    const dtSec = Math.max(0, Ticker.shared.elapsedMS) / 1000
    for (const burst of this.activeTransitions) {
      burst.step(dtSec)
      if (burst.isFinished) {
        this.fxContainer.removeChild(burst)
        burst.destroy({ children: true })
        this.activeTransitions.delete(burst)
      }
    }
    for (let i = this.activeScenarioEffects.length - 1; i >= 0; i--) {
      const overlay = this.activeScenarioEffects[i]
      overlay.step(dtSec)
      if (overlay.isStopped) {
        this.fxContainer.removeChild(overlay)
        overlay.destroy()
        this.activeScenarioEffects.splice(i, 1)
      }
    }
  }

  private spriteFor(color: 'black' | 'white'): SEBlack {
    return color === 'white' ? this.seWhiteSprite : this.seBlackSprite
  }

  private getSpriteAlpha(sprite: SEBlack): number {
    if (!sprite.visible) return 0
    const filter = sprite.filters?.[0] as { alpha?: number } | undefined
    if (filter && typeof filter.alpha === 'number') return filter.alpha
    return sprite.alpha
  }

  private setSpriteAlpha(sprite: SEBlack, alpha: number): void {
    const filter = sprite.filters?.[0] as { alpha?: number } | undefined
    if (filter) filter.alpha = alpha
    sprite.alpha = 1
  }

  public async fadeOut(duration: number, color: 'black' | 'white' = 'black'): Promise<void> {
    const gen = ++this.fadeGen
    const other = this.spriteFor(color === 'white' ? 'black' : 'white')
    const sprite = this.spriteFor(color)
    const startAlpha = Math.max(0, Math.min(1, this.getSpriteAlpha(sprite)))
    const otherAlpha = Math.max(0, Math.min(1, this.getSpriteAlpha(other)))
    sprite.visible = true

    if (other.visible && otherAlpha > 1e-3) {
      sprite.zIndex = 4
      other.zIndex = 3
    } else {
      other.visible = false
      this.setSpriteAlpha(other, 0)
    }

    if (duration <= 0 || startAlpha >= 1 - 1e-3 || (other.visible && otherAlpha >= 1 - 1e-3)) {
      // 单一颜色 fader：已在全遮不透明时换色只吸附 RGB，alpha 保持 1。
      this.setSpriteAlpha(sprite, 1)
      other.visible = false
      this.setSpriteAlpha(other, 0)
      if (duration > 0) {
        await AnimationManager.delay(duration)
      }
      if (gen === this.fadeGen) {
        this.seBlackSprite.zIndex = 3
        this.seWhiteSprite.zIndex = 4
      }
      return
    }

    this.setSpriteAlpha(sprite, startAlpha)
    await AnimationManager.linear(
      (progress) => {
        if (gen !== this.fadeGen) return
        this.setSpriteAlpha(sprite, startAlpha + (1 - startAlpha) * progress)
      },
      duration,
      false,
      {
        startMs: typeof performance !== 'undefined' ? performance.now() : 0,
        frames: msToFrameCount(duration)
      }
    )
    if (gen !== this.fadeGen) return
    this.setSpriteAlpha(sprite, 1)
    other.visible = false
    this.setSpriteAlpha(other, 0)
    this.seBlackSprite.zIndex = 3
    this.seWhiteSprite.zIndex = 4
  }

  public async fadeIn(duration: number, color: 'black' | 'white' = 'black'): Promise<void> {
    const gen = ++this.fadeGen
    const other = this.spriteFor(color === 'white' ? 'black' : 'white')
    other.visible = false
    this.setSpriteAlpha(other, 0)
    const sprite = this.spriteFor(color)
    // 官方 FadeIn 无条件从该色 alpha=1 淡到 0（`Play(Some([rgb, 1.0]), delay, duration)`）。
    const startAlpha = 1
    sprite.visible = true
    if (duration <= 0) {
      this.setSpriteAlpha(sprite, 0)
      sprite.visible = false
      return
    }
    this.setSpriteAlpha(sprite, startAlpha)
    await AnimationManager.linear(
      (progress) => {
        if (gen !== this.fadeGen) return
        this.setSpriteAlpha(sprite, startAlpha * (1 - progress))
      },
      duration,
      false,
      {
        startMs: typeof performance !== 'undefined' ? performance.now() : 0,
        frames: msToFrameCount(duration)
      }
    )
    if (gen !== this.fadeGen) return
    this.setSpriteAlpha(sprite, 0)
    sprite.visible = false
  }

  /** 官方开场黑屏幕遮（`OPENING_COVER_FADE = 0.5s`）：立刻全黑随后线性淡出。 */
  public async setOpeningCover(durationMs = 500): Promise<void> {
    this.seWhiteSprite.visible = false
    this.setSpriteAlpha(this.seBlackSprite, 1)
    this.seBlackSprite.visible = true
    await this.fadeIn(durationMs, 'black')
  }

  /** 官方收尾封包（`END_HOLD = 0.25s` + `END_FADE = 0.25s` 淡黑）。 */
  public async setEndingEnvelope(holdMs = 250, fadeMs = 250): Promise<void> {
    if (holdMs > 0) {
      await AnimationManager.delay(holdMs)
    }
    // 官方 end_frame 在 playedWaitTime 与场景退出之间多等 1 帧。
    await AnimationManager.delay(FRAME_MS)
    await this.fadeOut(fadeMs, 'black')
  }

  /**
   * 官方 `SekaiIn / SekaiOut` (`EffectType 20/21/40/41`)：
   * - `In`: 立刻纯白 → 等待 `0.25s` → 线性淡出到透明；
   * - `Out`: 爆发三角光片 + `SE_AREA_TRANSITION_SEKAI` → 等待 `0.50s` → 线性淡入到纯白。
   */
  public async playSekaiTransition(
    mode: 'In' | 'Out',
    durationMs: number,
    variant: 'v1' | 'v2' = 'v1'
  ): Promise<void> {
    this.ensureTicker()
    if (mode === 'In') {
      this.seBlackSprite.visible = false
      this.setSpriteAlpha(this.seWhiteSprite, 1)
      this.seWhiteSprite.visible = true
      await AnimationManager.delay(SEKAI_IN_FADE_DELAY_MS)
      await this.fadeIn(durationMs, 'white')
      return
    }

    const burst = new SekaiTransitionParticles(
      this.app.screen.width,
      this.app.screen.height,
      variant
    )
    this.fxContainer.addChild(burst)
    this.activeTransitions.add(burst)

    if (!this.isExportMode && typeof Audio !== 'undefined') {
      try {
        const audio = new Audio(inappUrl('audio/MenuCommon/SE_AREA_TRANSITION_SEKAI.wav'))
        audio.volume = 0.8
        void audio.play().catch(() => undefined)
      } catch {
        // ignore audio decode failures
      }
    }

    await AnimationManager.delay(SEKAI_OUT_FADE_DELAY_MS)
    await this.fadeOut(durationMs, 'white')
  }

  public async wipe(
    direction: 'left' | 'right',
    mode: 'in' | 'out',
    duration: number
  ): Promise<void> {
    const w = this.app.screen.width
    const fromRight = direction === 'right'
    const start = mode === 'in' ? (fromRight ? w : -w) : 0
    const end = mode === 'in' ? 0 : fromRight ? w : -w

    const rawWipe = Texture.from(ui_se_black)
    this.wipeSprite.texture = isTextureUsable(rawWipe) ? rawWipe : buildSolidColorTexture('#000000')
    this.wipeSprite.width = w
    this.wipeSprite.height = this.app.screen.height
    this.wipeSprite.visible = true
    this.wipeSprite.y = 0
    this.wipeSprite.x = start
    await runEasedTween(duration, 'OutQuad', (p) => {
      this.wipeSprite.x = start + (end - start) * p
    })
    if (mode === 'out') {
      this.wipeSprite.visible = false
      this.wipeSprite.x = 0
    }
  }

  private getSideFadeTexture(
    horizontal: boolean,
    featherSide: 'start' | 'end',
    w: number,
    h: number,
    feather: number
  ): Texture {
    const key = `${horizontal ? 'h' : 'v'}:${featherSide}:${Math.round(w)}x${Math.round(h)}:${feather}`
    const cached = this.sideFadeTextures.get(key)
    if (isTextureUsable(cached)) return cached
    const tex = buildFeatheredSideFadeTexture(w, h, feather, horizontal, featherSide)
    this.sideFadeTextures.set(key, tex)
    return tex
  }

  /**
   * 官方 `ScenarioSideFadePlayer` (`EffectType 29~36`):
   * - 根节点是 `contentSize + 64` 的纯黑面板（四周各留 32px）；
   * - 面板外四条边各铺 512px 的 `tex_transition_*` 渐变（靠面板全黑、向外透明）；
   * - `Play` 把 anchoredPosition 从 from 移到 to（OutQuad），屏幕上的前沿是
   *   `面板边 − 512`（向左右移动）或 `面板边 − 512`（向上下移动）。
   * 旧实现用一块硬边黑布从 `w+512` 直接滑入，前沿比参考晚 544px，边缘检测拟合
   * 残差 ~19px；这里按参考的 64px 内边距 + 512px 羽化重建。
   */
  public async playSideFade(
    mode: 'In' | 'Out' | 'in' | 'out',
    direction: SideFadeDirection,
    durationMs: number
  ): Promise<void> {
    const gen = ++this.sideFadeGen
    const w = this.app.screen.width
    const h = this.app.screen.height
    const EDGE = 512
    const PAD = 32
    const rw = w + PAD * 2
    const rh = h + PAD * 2
    const ox = w + EDGE
    const oy = h + EDGE
    const normMode = String(mode).toLowerCase() === 'in' ? 'in' : 'out'
    const dir = String(direction).toLowerCase() as 'left' | 'right' | 'top' | 'bottom'
    const horizontal = dir === 'left' || dir === 'right'
    // root = 黑色面板左上角；leading = 运动方向上的前沿边（带 512px 羽化）。
    let from = { x: -PAD, y: -PAD }
    let to = { x: -PAD, y: -PAD }
    let hide = false
    let leading: 'start' | 'end' = 'start'
    if (dir === 'right') {
      // RightIn: 0 → -ox（向左退场）；RightOut: +ox → 0（向左盖住）。
      leading = 'start'
      if (normMode === 'in') {
        to = { x: -PAD - ox, y: -PAD }
        hide = true
      } else {
        from = { x: -PAD + ox, y: -PAD }
      }
    } else if (dir === 'left') {
      // LeftIn: 0 → +ox（向右退场）；LeftOut: -ox → 0（向右盖住）。
      leading = 'end'
      if (normMode === 'in') {
        to = { x: -PAD + ox, y: -PAD }
        hide = true
      } else {
        from = { x: -PAD - ox, y: -PAD }
      }
    } else if (dir === 'top') {
      // 画布 y 向下：TopIn 0 → +oy（向下退场）；TopOut -oy → 0（向下盖住）。
      leading = 'end'
      if (normMode === 'in') {
        to = { x: -PAD, y: -PAD + oy }
        hide = true
      } else {
        from = { x: -PAD, y: -PAD - oy }
      }
    } else {
      // BottomIn 0 → -oy（向上退场）；BottomOut +oy → 0（向上盖住）。
      leading = 'start'
      if (normMode === 'in') {
        to = { x: -PAD, y: -PAD - oy }
        hide = true
      } else {
        from = { x: -PAD, y: -PAD + oy }
      }
    }

    const texture = this.getSideFadeTexture(horizontal, leading, rw, rh, EDGE)
    this.wipeSprite.texture = texture
    this.wipeSprite.width = horizontal ? rw + EDGE : rw
    this.wipeSprite.height = horizontal ? rh : rh + EDGE
    this.wipeSprite.visible = true
    // 前沿羽化从面板边向外 512px：横向 start 把 sprite 放到 root.x−512；
    // 纵向 start 放到 root.y−512；end 侧 sprite 从 root 开始。
    const spriteFrom = {
      x: from.x - (horizontal && leading === 'start' ? EDGE : 0),
      y: from.y - (!horizontal && leading === 'start' ? EDGE : 0)
    }
    const spriteTo = {
      x: to.x - (horizontal && leading === 'start' ? EDGE : 0),
      y: to.y - (!horizontal && leading === 'start' ? EDGE : 0)
    }
    this.wipeSprite.x = spriteFrom.x
    this.wipeSprite.y = spriteFrom.y

    await runEasedTween(
      durationMs,
      'OutQuad',
      (p) => {
        if (gen !== this.sideFadeGen) return
        this.wipeSprite.x = spriteFrom.x + (spriteTo.x - spriteFrom.x) * p
        this.wipeSprite.y = spriteFrom.y + (spriteTo.y - spriteFrom.y) * p
      },
      () => gen !== this.sideFadeGen
    )

    if (gen !== this.sideFadeGen) return
    this.wipeSprite.x = spriteTo.x
    this.wipeSprite.y = spriteTo.y
    // In 类型在结束时 deactivate；Out 类型保留面板盖住画面。
    this.wipeSprite.visible = !hide
  }

  /** 向后兼容旧签名 `(edge, mode, duration)`。 */
  public async sideFade(
    edge: 'left' | 'right' | 'top' | 'bottom',
    mode: 'in' | 'out',
    duration: number
  ): Promise<void> {
    await this.playSideFade(mode, edge, duration)
  }

  /** 官方 `EffectType 15 PlayScenarioEffect`: 延迟 delayMs 后生成天气/粒子/回忆框特效。 */
  public async playScenarioEffect(name: string, delayMs = 0): Promise<void> {
    this.ensureTicker()
    if (delayMs > 0) {
      await AnimationManager.delay(delayMs)
    }
    const overlay = new ScenarioEffectOverlay(name, this.app.screen.width, this.app.screen.height)
    this.fxContainer.addChild(overlay)
    this.activeScenarioEffects.push(overlay)
  }

  /** 官方 `EffectType 16 StopScenarioEffect`。 */
  public async stopScenarioEffect(name: string, delayMs = 0): Promise<void> {
    if (delayMs > 0) {
      await AnimationManager.delay(delayMs)
    }
    const stopAll = !name || name === '*' || name.toLowerCase() === 'all'
    for (const overlay of this.activeScenarioEffects) {
      if (stopAll || overlay.effectName === name || overlay.preset === name) {
        overlay.beginStop()
      }
    }
  }

  /** 官方 `EffectType 38/39 BlurIn/BlurOut`: 镜头 5-tap 高斯模糊，OutQuad 缓动。 */
  public async setCameraBlur(active: boolean, durationMs: number): Promise<void> {
    const gen = ++this.cameraBlurGen
    const scale = this.app.screen.width / 1920
    const seconds = Math.max(0, durationMs) / 1000
    // 官方 `Spread = 3 × min(tween / duration, 1)`（Out 为 `3 × (1 − …)`）：
    // tween 值本身是 0..1，所以短于 1 秒的模糊会提前饱和，长于 1 秒的到不了 3。
    const spreadAt = (progress: number): number => {
      const k = seconds > 0 ? Math.min(progress / seconds, 1) : 1
      return 3 * scale * (active ? k : 1 - k)
    }
    if (active) {
      this.filterSyncCallback?.(this.cameraBlurFilter)
    }
    await runEasedTween(
      durationMs,
      'OutQuad',
      (p) => {
        if (gen !== this.cameraBlurGen) return
        this.cameraBlurFilter.spread = spreadAt(p)
        this.filterSyncCallback?.(
          this.cameraBlurFilter.spread > 0.001 ? this.cameraBlurFilter : null
        )
      },
      () => gen !== this.cameraBlurGen
    )
    if (gen !== this.cameraBlurGen) return
    this.cameraBlurFilter.spread = active ? 3 * scale * Math.min(1 / Math.max(seconds, 1e-6), 1) : 0
    this.filterSyncCallback?.(this.cameraBlurFilter.spread > 0.001 ? this.cameraBlurFilter : null)
  }

  /** 官方 `EffectType 19 Movie`: 0.5s 黑屏淡出 → 播放居中 2338x1080 视频 → 0.5s 恢复。 */
  public async playMovie(file: string, durationMs = 2000): Promise<void> {
    await this.fadeOut(500, 'black')
    if (typeof document !== 'undefined' && file) {
      try {
        const video = document.createElement('video')
        video.src =
          /^https?:\/\//i.test(file) || file.startsWith('/')
            ? file
            : `/resources/${file.replace(/^\/+/, '')}`
        video.muted = true
        video.playsInline = true
        this.movieSprite.texture = Texture.from(video)
        const scale = this.app.screen.height / 1080
        this.movieSprite.width = 2338 * scale
        this.movieSprite.height = 1080 * scale
        this.movieSprite.visible = true
        this.seBlackSprite.visible = false
        void video.play().catch(() => undefined)
        await AnimationManager.delay(Math.max(100, durationMs))
        video.pause()
        this.movieSprite.visible = false
        await this.fadeOut(500, 'black')
        await this.fadeIn(500, 'black')
        return
      } catch {
        this.movieSprite.visible = false
      }
    }
    await AnimationManager.delay(Math.max(100, durationMs))
    await this.fadeIn(500, 'black')
  }

  public reset(): void {
    this.fadeGen++
    this.sideFadeGen++
    this.cameraBlurGen++
    this.cameraBlurFilter.spread = 0
    this.filterSyncCallback?.(null)
    this.seBlackSprite.visible = false
    this.setSpriteAlpha(this.seBlackSprite, 0)
    this.seBlackSprite.zIndex = 3
    this.seWhiteSprite.visible = false
    this.setSpriteAlpha(this.seWhiteSprite, 0)
    this.seWhiteSprite.zIndex = 4
    this.wipeSprite.visible = false
    this.movieSprite.visible = false
    for (const burst of this.activeTransitions) {
      this.fxContainer.removeChild(burst)
      burst.destroy({ children: true })
    }
    this.activeTransitions.clear()
    for (const overlay of this.activeScenarioEffects) {
      this.fxContainer.removeChild(overlay)
      overlay.destroy()
    }
    this.activeScenarioEffects.length = 0
  }

  public destroy(): void {
    this.reset()
    if (this.tickerAttached) {
      Ticker.shared.remove(this.stepEffects, this)
      this.tickerAttached = false
    }
    this.filterSyncCallback = null
    this.cameraBlurFilter.destroy()
    for (const tex of this.sideFadeTextures.values()) {
      tex.destroy(true)
    }
    this.sideFadeTextures.clear()
  }
}
