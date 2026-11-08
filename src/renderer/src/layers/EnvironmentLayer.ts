import { Application, Sprite, Texture } from 'pixi.js'
import BaseLayer from './BaseLayer'
import ui_se_black from '../../assets/ui/ui_se_black.svg'
import AnimationManager from '../managers/AnimationManager'

/**
 * 回忆滤镜层（PJSK FlashbackIn/Out）。
 * 位于人物层之上、对话框之下，把背景与人物一起压暗。
 */
export default class EnvironmentLayer extends BaseLayer {
  private readonly flashbackSprite: Sprite

  constructor(app: Application) {
    super(app, 1.5)

    this.flashbackSprite = new Sprite(Texture.from(ui_se_black))
    this.flashbackSprite.anchor.set(0.5)
    this.flashbackSprite.x = this.app.screen.width / 2
    this.flashbackSprite.y = this.app.screen.height / 2
    this.flashbackSprite.width = this.app.screen.width * 1.1
    this.flashbackSprite.height = this.app.screen.height
    this.flashbackSprite.alpha = 0
    this.flashbackSprite.visible = false

    this.layerContainer.addChild(this.flashbackSprite)
  }

  public async flashbackIn(duration: number, alpha: number): Promise<void> {
    this.flashbackSprite.visible = true
    const from = this.flashbackSprite.alpha
    const to = Math.max(0, Math.min(1, alpha))
    await AnimationManager.linear((progress) => {
      this.flashbackSprite.alpha = from + (to - from) * progress
    }, duration)
  }

  public async flashbackOut(duration: number): Promise<void> {
    const from = this.flashbackSprite.alpha
    await AnimationManager.linear((progress) => {
      this.flashbackSprite.alpha = from * (1 - progress)
    }, duration)
    this.flashbackSprite.visible = false
    this.flashbackSprite.alpha = 0
  }
}
