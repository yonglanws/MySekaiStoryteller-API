import { AlphaFilter, Text, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

export default class UISpeakerText extends Text {
  constructor(screen_width: number, screen_height: number, y: number) {
    const x = screen_width / 9

    const style = new TextStyle({
      align: 'left',
      fill: '#FFFFFFF5',
      fontFamily: 'FOT Rodin NTLG Pro',
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
    this.y = y

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]
  }

  public async show(time: number): Promise<void> {
    this.visible = true
    const alphaFilter: AlphaFilter = this.filters![0] as AlphaFilter
    alphaFilter.alpha = 0

    await AnimationManager.linear((progress) => {
      alphaFilter.alpha = progress
    }, time)
  }

  public async hide(time: number): Promise<void> {
    const alphaFilter: AlphaFilter = this.filters![0] as AlphaFilter
    alphaFilter.alpha = 1

    await AnimationManager.linear((progress) => {
      alphaFilter.alpha = 1 - progress
    }, time)

    this.visible = false
  }
}
