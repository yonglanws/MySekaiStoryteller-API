import { AlphaFilter, Text, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

/**
 * 官方 `TalkWindow/Name`（`[230, 790, 593, 44]` @ 1920×1080，色值 `#EBECF2`，无厚重描边）。
 */
export default class UISpeakerText extends Text {
  private animGen = 0

  constructor(screen_width: number, screen_height: number, y?: number) {
    const k = Math.min(screen_width / 1920, screen_height / 1080)
    const style = new TextStyle({
      align: 'left',
      fill: '#EBECF2',
      fontFamily: "'MiSans Medium', sans-serif",
      fontSize: 40 * k,
      fontWeight: '600',
      stroke: 'rgba(68, 68, 102, 0.55)',
      strokeThickness: 1.5 * k
    })
    super('', style)
    this.anchor.set(0, 1)
    this.x = 230 * k
    this.y = y !== undefined && y > 0 ? y : 820 * k

    const alphaFilter = new AlphaFilter(0)
    alphaFilter.resolution = 2
    this.filters = [alphaFilter]
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
