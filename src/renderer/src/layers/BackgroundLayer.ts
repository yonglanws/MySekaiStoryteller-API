import { Application, BlurFilter, Sprite, Texture } from 'pixi.js'
import BaseLayer from './BaseLayer'

export default class BackgroundLayer extends BaseLayer {
  private readonly sprite!: Sprite
  private readonly blurFilter = new BlurFilter(8, 4)

  constructor(app: Application) {
    super(app, -1)

    this.sprite = new Sprite()

    this.sprite.x = this.app.screen.width / 2
    this.sprite.y = this.app.screen.height / 2
    this.sprite.anchor.set(0.5)

    this.layerContainer.addChild(this.sprite)
  }

  public setBlur(enabled: boolean): void {
    this.sprite.filters = enabled ? [this.blurFilter] : []
  }

  private calcScale(texture: Texture): number {
    if (texture.width / texture.height > this.app.screen.width / this.app.screen.height) {
      return this.app.screen.height / texture.height
    } else {
      return this.app.screen.width / texture.width
    }
  }

  public setBackground(texture: Texture): void {
    this.sprite.scale.set(this.calcScale(texture))

    this.sprite.texture = texture
  }
}
