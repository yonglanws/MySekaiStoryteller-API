import { AlphaFilter, Container, Sprite, Text, TextStyle, Texture } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UITelop extends Container {
  private readonly telopSprite!: Sprite
  private readonly telopText: Text
  private animGen = 0

  constructor(telopTexture: Texture, screen_width: number, screen_height: number) {
    super()
    this.visible = false
    this.x = 0
    this.y = 0

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]

    this.telopSprite = new Sprite(telopTexture)
    this.telopSprite.anchor.set(0.5)
    this.telopSprite.x = screen_width / 2
    this.telopSprite.y = screen_height / 2
    this.telopSprite.scale.x = screen_width / 1920
    this.telopSprite.height = screen_height / 8

    const style = new TextStyle({
      align: 'center',
      fill: '#FFFFFF',
      fontFamily: "'MiSans Medium', sans-serif",
      fontSize: screen_height / 23,
      textBaseline: 'bottom'
    })
    this.telopText = new Text('', style)
    this.telopText.anchor.set(0.5)
    this.telopText.x = screen_width / 2 - 11
    this.telopText.y = screen_height / 2 + screen_height / 120

    this.addChild(this.telopSprite)
    this.addChild(this.telopText)
  }

  set text(text: string) {
    this.telopText.text = text
  }

  /**
   * Reset container origin so repeated Telop shows never accumulate horizontal drift.
   */
  private resetOrigin(): void {
    this.x = 0
    this.y = 0
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    this.resetOrigin()
    const startX = -10
    const originalX = 0

    this.visible = true
    const alphaFilter = this.filters![0] as AlphaFilter
    if (time <= 0) {
      alphaFilter.alpha = 1
      this.x = originalX
      return
    }
    alphaFilter.alpha = 0
    this.x = startX

    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      alphaFilter.alpha = progress
      this.x = startX + (originalX - startX) * progress
    }, time)

    if (gen === this.animGen) {
      alphaFilter.alpha = 1
      this.x = originalX
    }
  }

  public async hide(time: number): Promise<void> {
    const gen = ++this.animGen
    this.resetOrigin()
    const startX = 0
    const targetX = 10

    const alphaFilter = this.filters![0] as AlphaFilter
    if (time > 0) {
      const fromAlpha = alphaFilter.alpha
      await AnimationManager.linear((progress) => {
        if (gen !== this.animGen) return
        alphaFilter.alpha = fromAlpha * (1 - progress)
        this.x = startX + (targetX - startX) * progress
      }, time)
    }

    if (gen === this.animGen) {
      alphaFilter.alpha = 0
      this.resetOrigin()
      this.visible = false
    }
  }
}
