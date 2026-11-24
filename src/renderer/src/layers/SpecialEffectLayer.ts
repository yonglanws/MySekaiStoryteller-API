import { Application, Container, Rectangle, Sprite, Texture, Ticker, type Filter } from 'pixi.js'
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
  framesForSeconds
} from '../../../common/official/timing'
import { cameraBlurSpread } from '../../../common/official/cameraBlur'
import {
  sideFadeEdgeTiles,
  sideFadePlan,
  sideFadePanelRect,
  type SideFadeEdge,
  type SideFadeEdgeTile,
  type SideFadePlan
} from '../../../common/official/sideFade'
import { recordEffectProbe } from '../utils/EffectProbe'

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

/** 全屏转场、SideFade 硬边面板、SekaiTransition、相机模糊、剧情粒子与视频播放层。 */
export default class SpecialEffectLayer extends BaseLayer {
  private readonly seBlackSprite: SEBlack
  private readonly seWhiteSprite: SEBlack
  private readonly wipeSprite: Sprite
  private readonly wipeBlackTexture: Texture
  private readonly sideFadeContainer = new Container()
  private readonly sideFadeSubtextures = new Map<string, Texture>()
  private sideFadeSprites: Sprite[] = []
  private sideFadeEdgeLeft: Texture | null = null
  private sideFadeEdgeTop: Texture | null = null
  private readonly fxContainer: Container
  private readonly movieSprite: Sprite
  private readonly cameraBlurFilter = new CameraBlurFilter(0)
  private readonly activeTransitions = new Set<SekaiTransitionParticles>()
  private readonly activeScenarioEffects: ScenarioEffectOverlay[] = []
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

    this.wipeBlackTexture = sfBlackTexture
    this.wipeSprite = new Sprite(this.wipeBlackTexture)
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
    this.sideFadeContainer.zIndex = 6
    this.sideFadeContainer.visible = false

    this.layerContainer.addChild(
      this.fxContainer,
      this.movieSprite,
      this.seBlackSprite,
      this.seWhiteSprite,
      this.wipeSprite,
      this.sideFadeContainer
    )

    void loadInappTexture('player/loose/Texture2D/tex_transition_left.png').then((tex) => {
      this.sideFadeEdgeLeft = tex
    })
    void loadInappTexture('player/loose/Texture2D/tex_transition_top.png').then((tex) => {
      this.sideFadeEdgeTop = tex
    })
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

    const startMs = typeof performance !== 'undefined' ? performance.now() : 0
    const frames = framesForSeconds(duration / 1000)
    recordEffectProbe('fade-start', {
      direction: 'out',
      color,
      durationMs: duration,
      frames,
      startMs
    })
    this.setSpriteAlpha(sprite, startAlpha)
    await AnimationManager.linear(
      (progress) => {
        if (gen !== this.fadeGen) return
        this.setSpriteAlpha(sprite, startAlpha + (1 - startAlpha) * progress)
      },
      duration,
      false,
      { startMs, frames }
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
    const startMs = typeof performance !== 'undefined' ? performance.now() : 0
    const frames = framesForSeconds(duration / 1000)
    recordEffectProbe('fade-start', {
      direction: 'in',
      color,
      durationMs: duration,
      frames,
      startMs
    })
    this.setSpriteAlpha(sprite, startAlpha)
    await AnimationManager.linear(
      (progress) => {
        if (gen !== this.fadeGen) return
        this.setSpriteAlpha(sprite, startAlpha * (1 - progress))
      },
      duration,
      false,
      { startMs, frames }
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

  private sideFadeSubtexture(base: Texture, tile: SideFadeEdgeTile): Texture {
    const frame = tile.frame
    const key = `${tile.texture}:${Math.round(frame.x)}:${Math.round(frame.y)}:${Math.round(
      frame.width
    )}:${Math.round(frame.height)}`
    const cached = this.sideFadeSubtextures.get(key)
    if (isTextureUsable(cached)) return cached
    const texture = new Texture(
      base.baseTexture,
      new Rectangle(frame.x, frame.y, frame.width, frame.height)
    )
    this.sideFadeSubtextures.set(key, texture)
    return texture
  }

  /** 根黑面板 + 四周 512px `tex_transition_*` tile（参考 `sse-render/src/lib.rs:1288-1342`）。 */
  private rebuildSideFade(plan: SideFadePlan): void {
    for (const sprite of this.sideFadeSprites) {
      this.sideFadeContainer.removeChild(sprite)
    }
    this.sideFadeSprites = []

    const root = new Sprite(this.wipeBlackTexture)
    root.anchor.set(0)
    root.width = plan.panel.width
    root.height = plan.panel.height
    root.position.set(0, 0)
    this.sideFadeContainer.addChild(root)
    this.sideFadeSprites.push(root)

    const left = this.sideFadeEdgeLeft
    const top = this.sideFadeEdgeTop
    if (!left || !top || !isTextureUsable(left) || !isTextureUsable(top)) return

    for (const tile of sideFadeEdgeTiles(plan)) {
      const base = tile.texture === 'top' ? top : left
      const sprite = new Sprite(this.sideFadeSubtexture(base, tile))
      sprite.anchor.set(0)
      // 翻转时把 sprite 放到 tile 的另一边，再取负 scale 回到 tile 区域。
      sprite.position.set(
        tile.flipX ? tile.x + tile.width : tile.x,
        tile.flipY ? tile.y + tile.height : tile.y
      )
      sprite.width = tile.width
      sprite.height = tile.height
      if (tile.flipX) sprite.scale.x *= -1
      if (tile.flipY) sprite.scale.y *= -1
      this.sideFadeContainer.addChild(sprite)
      this.sideFadeSprites.push(sprite)
    }
  }

  /**
   * 官方 `ScenarioSideFadePlayer` (`EffectType 29~36`)：根节点是
   * `contentSize + 64` 的纯黑面板，`anchoredPosition` 按参考表 from→to
   * （OutQuad）移动 `contentSize + 512`；四周铺 512px `tex_transition_*` 羽化 tile，
   * In 类型在结束时 deactivate（`sse-render/src/lib.rs:1288-1342`）。
   */
  public async playSideFade(
    mode: 'In' | 'Out' | 'in' | 'out',
    direction: SideFadeDirection,
    durationMs: number
  ): Promise<void> {
    const gen = ++this.sideFadeGen
    const w = this.app.screen.width
    const h = this.app.screen.height
    // 512/32 是 1920×1080 参考画布像素；导出逻辑画布 1280×720、resolution=1.5。
    const normMode = String(mode).toLowerCase() === 'in' ? 'in' : 'out'
    const edge = String(direction).toLowerCase() as SideFadeEdge
    const plan = sideFadePlan(edge, normMode, w, h, w > 0 ? w / 1920 : 1)
    const start = sideFadePanelRect(plan, 0)
    const end = sideFadePanelRect(plan, 1)

    this.rebuildSideFade(plan)
    this.sideFadeContainer.position.set(start.x, start.y)
    this.sideFadeContainer.visible = true
    recordEffectProbe('sidefade', {
      effectType: plan.effectType,
      edge: plan.edge,
      mode: plan.mode,
      hide: plan.hide,
      content: plan.content,
      unitScale: plan.unitScale,
      resolution: this.app.renderer?.resolution ?? 1,
      pad: plan.pad,
      panel: plan.panel,
      from: plan.from,
      to: plan.to,
      startLeading: start.leading,
      endLeading: end.leading,
      edgeTiles: sideFadeEdgeTiles(plan).length
    })

    await runEasedTween(
      durationMs,
      'OutQuad',
      (p) => {
        if (gen !== this.sideFadeGen) return
        const rect = sideFadePanelRect(plan, p)
        this.sideFadeContainer.position.set(rect.x, rect.y)
      },
      () => gen !== this.sideFadeGen
    )

    if (gen !== this.sideFadeGen) return
    this.sideFadeContainer.position.set(end.x, end.y)
    // In 类型在结束时 deactivate；Out 类型保留面板盖住画面。
    this.sideFadeContainer.visible = !plan.hide
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
    const resolution = this.app.renderer?.resolution ?? 1
    const seconds = Math.max(0, durationMs) / 1000
    // 官方 `Spread = 3 × min(tween / duration, 1)`（Out 为 `3 × (1 − …)`）：
    // tween 值本身是 0..1，所以短于 1 秒的模糊会提前饱和，长于 1 秒的到不了 3。
    const spreadAt = (tweenValue: number): number =>
      scale * cameraBlurSpread(active, seconds, tweenValue)
    if (active) {
      this.filterSyncCallback?.(this.cameraBlurFilter)
    }
    await runEasedTween(
      durationMs,
      'OutQuad',
      (p, raw) => {
        if (gen !== this.cameraBlurGen) return
        const spread = spreadAt(p)
        this.cameraBlurFilter.spread = spread
        // 逐帧写进导出日志：spread 与 tween 值成对，可反演公式与缓动。
        recordEffectProbe('blur-spread', {
          active,
          durationSec: seconds,
          tweenValue: p,
          raw,
          spread,
          scale,
          resolution
        })
        this.filterSyncCallback?.(
          this.cameraBlurFilter.spread > 0.001 ? this.cameraBlurFilter : null
        )
      },
      () => gen !== this.cameraBlurGen
    )
    if (gen !== this.cameraBlurGen) return
    const finalSpread = active ? spreadAt(1) : 0
    this.cameraBlurFilter.spread = finalSpread
    recordEffectProbe('blur-final', {
      active,
      durationSec: seconds,
      spread: finalSpread,
      scale,
      resolution
    })
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
    this.sideFadeContainer.visible = false
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
    for (const texture of this.sideFadeSubtextures.values()) {
      texture.destroy(false)
    }
    this.sideFadeSubtextures.clear()
  }
}
