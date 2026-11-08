import BaseLayer from './BaseLayer'
import { Application, Sprite, Texture } from 'pixi.js'
import ui_se_black from '../../assets/ui/ui_se_black.svg'
import SEBlack from '../components/SEBlack'
import AnimationManager from '../managers/AnimationManager'
import { sideFadePositions } from '../../../common/official/sideFade'

/** 全屏淡入淡出 / 黑幕扫过 —— PJSK 的 BlackOut/WhiteOut、BlackWipe*。 */
export default class SpecialEffectLayer extends BaseLayer {
  private readonly seBlackSprite!: SEBlack
  private readonly seWhiteSprite!: SEBlack
  private readonly wipeSprite!: Sprite

  constructor(app: Application) {
    super(app, 3)

    const sfBlackTexture = Texture.from(ui_se_black)
    this.seBlackSprite = new SEBlack(sfBlackTexture, this.app.screen.width, this.app.screen.height)
    // Texture.WHITE 是纯白 1×1，拉伸到全屏即为白色闪屏
    this.seWhiteSprite = new SEBlack(Texture.WHITE, this.app.screen.width, this.app.screen.height)
    this.seWhiteSprite.visible = false

    this.wipeSprite = new Sprite(sfBlackTexture)
    this.wipeSprite.anchor.set(0)
    this.wipeSprite.width = this.app.screen.width
    this.wipeSprite.height = this.app.screen.height
    this.wipeSprite.visible = false

    this.layerContainer.addChild(this.seBlackSprite)
    this.layerContainer.addChild(this.seWhiteSprite)
    this.layerContainer.addChild(this.wipeSprite)
  }

  public async fadeOut(duration: number, color: 'black' | 'white' = 'black'): Promise<void> {
    const sprite = color === 'white' ? this.seWhiteSprite : this.seBlackSprite
    await sprite.show(duration)
  }

  public async fadeIn(duration: number, color: 'black' | 'white' = 'black'): Promise<void> {
    const sprite = color === 'white' ? this.seWhiteSprite : this.seBlackSprite
    await sprite.hide(duration)
  }

  /**
   * 黑幕扫过：in = 从画外扫入覆盖画面，out = 从覆盖状态扫出。
   * direction 是幕布移动方向（right = 从左向右扫）。
   */
  public async wipe(
    mode: 'in' | 'out',
    direction: 'left' | 'right',
    duration: number
  ): Promise<void> {
    const width = this.app.screen.width
    const start = mode === 'in' ? (direction === 'right' ? -width : width) : 0
    const end = mode === 'in' ? 0 : direction === 'right' ? width : -width

    this.wipeSprite.visible = true
    this.wipeSprite.x = start

    await AnimationManager.linear((progress) => {
      this.wipeSprite.x = start + (end - start) * progress
    }, duration)

    if (mode === 'out') {
      this.wipeSprite.visible = false
      this.wipeSprite.x = 0
    }
  }

  /**
   * 官方 ScenarioSideFadePlayer（EffectType 29~36）：黑幕从一侧滑入覆盖 / 向一侧滑出。
   * out = 覆盖（结束后保持全黑）；in = 露出（结束后隐藏）。
   */
  public async sideFade(
    edge: 'left' | 'right' | 'top' | 'bottom',
    mode: 'in' | 'out',
    duration: number
  ): Promise<void> {
    const { horizontal, start, end } = sideFadePositions(
      edge,
      mode,
      this.app.screen.width,
      this.app.screen.height
    )

    this.wipeSprite.visible = true
    this.wipeSprite.x = horizontal ? start : 0
    this.wipeSprite.y = horizontal ? 0 : start

    await AnimationManager.linear((progress) => {
      const value = start + (end - start) * progress
      if (horizontal) this.wipeSprite.x = value
      else this.wipeSprite.y = value
    }, duration)

    if (mode === 'in') {
      this.wipeSprite.visible = false
      this.wipeSprite.x = 0
      this.wipeSprite.y = 0
    }
  }
}
