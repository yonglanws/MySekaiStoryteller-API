import { Application, Container, DisplayObject } from 'pixi.js'

export default abstract class BaseLayer {
  protected readonly app: Application
  protected readonly stage: Container<DisplayObject>
  protected readonly layerContainer: Container<DisplayObject>

  protected constructor(app: Application, zIndex: number) {
    this.app = app
    this.stage = app.stage
    this.layerContainer = new Container()
    this.layerContainer.zIndex = zIndex

    this.stage.addChild(this.layerContainer)
  }

  /**
   * 相机变换：以画面中心为轴缩放并平移。
   * 只作用于背景/人物层，UI 与全屏特效不参与（与 PJSK 的 camera 层一致）。
   */
  public setViewTransform(scale: number, offsetX: number, offsetY: number): void {
    const width = this.app.screen.width
    const height = this.app.screen.height
    this.layerContainer.pivot.set(width / 2, height / 2)
    this.layerContainer.position.set(width / 2 + offsetX, height / 2 + offsetY)
    this.layerContainer.scale.set(scale)
  }
}
