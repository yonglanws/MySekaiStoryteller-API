import { AlphaFilter, Text, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UISpeakerText extends Text {
  private animGen = 0

  constructor(screen_width: number, screen_height: number, y?: number) {
    const x = screen_width / 9

    const style = new TextStyle({
      align: 'left',
      fill: '#FFFFFFF5',
      fontFamily: "'MiSans Medium', sans-serif",
      fontSize: screen_height / 25,
      fontWeight: '600',
      stroke: '#4A4968D9',
      strokeThickness: screen_height / 120,
      wordWrap: true,
      wordWrapWidth: screen_width * 0.7,
      breakWords: true
    })
    super('', style)

    this.x = x
    this.y = y ?? screen_height / 1.3 - screen_width / 37

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    this.visible = true
    const alphaFilter = this.filters![0] as AlphaFilter
    alphaFilter.alpha = time <= 0 ? 1 : 0
    if (time > 0) {
      await AnimationManager.linear((progress) => {
        if (gen !== this.animGen) return
        alphaFilter.alpha = progress
      }, time)
      if (gen === this.animGen) alphaFilter.alpha = 1
    }
  }

  public async hide(time: number): Promise<void> {
    const gen = ++this.animGen
    const alphaFilter = this.filters![0] as AlphaFilter
    if (time <= 0) {
      alphaFilter.alpha = 0
      this.visible = false
      return
    }
    const from = alphaFilter.alpha
    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      alphaFilter.alpha = from * (1 - progress)
    }, time)
    if (gen === this.animGen) {
      alphaFilter.alpha = 0
      this.visible = false
    }
  }
}
