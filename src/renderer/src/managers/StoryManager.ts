import { SnippetData, StoryData } from '../../../common/types/Story'
import { Live2DModelMap, TextureMap } from '../types/AssetMap'
import AdvancedModel from '../model/AdvancedModel'
import { Resource, Texture, Ticker } from 'pixi.js'
import { Cubism2InternalModel } from 'pixi-live2d-display-advanced'
import { resourceUrl } from '../utils/ResourceUrl'

/**
 * 故事资源管理器：模型 / 背景 / 语音统一从宿主静态资源根（/resources/*）加载。
 * 纯 API 模式下故事只引用内置资源，不再存在外部剧本目录分支。
 */
export default class StoryManager {
  public readonly storyData: StoryData

  constructor(storyData: StoryData) {
    this.storyData = storyData
  }

  public async preloadModels(): Promise<Live2DModelMap[]> {
    const result: Live2DModelMap[] = []
    for (const model_data of this.storyData.models) {
      const fullPath = resourceUrl(`models/${model_data.model}`)

      let model: AdvancedModel

      try {
        model = await AdvancedModel.from(fullPath, {
          ticker: Ticker.shared,
          autoFocus: false,
          autoHitTest: false,
          breathDepth: 0
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'Network error.') {
          throw new Error(
            `Model ${model_data.id} could not be loaded.\nModel path: ${model_data.model}\n`,
            {
              cause: error
            }
          )
        }
        throw error
      }

      if (model.internalModel instanceof Cubism2InternalModel) {
        model.internalModel.setAutoBlinkEnable(false)
      }

      model.initialize(model_data)

      // Cue timing must not include a first-use network fetch, especially under the virtual clock.
      const actionNames = new Set<string>()
      for (const snippet of this.storyData.snippets) {
        // 入场/退场动作也必须预加载：旧代码只扫 Talk/Motion，第一次 LayoutAppear
        // 才去加载动作文件，淡入已经开始了动作还没开始，形成“入场站桩”。
        if (
          snippet.type !== 'Talk' &&
          snippet.type !== 'Motion' &&
          snippet.type !== 'LayoutAppear' &&
          snippet.type !== 'LayoutClear'
        )
          continue
        if (snippet.data.modelId === model_data.id) {
          if (snippet.data.motion) actionNames.add(snippet.data.motion)
          if (snippet.data.facial) actionNames.add(snippet.data.facial)
        }
        if (snippet.type === 'Talk' || snippet.type === 'Motion') {
          for (const action of snippet.data.actions ?? []) {
            if (action.modelId !== model_data.id) continue
            if (action.motion) actionNames.add(action.motion)
            if (action.facial) actionNames.add(action.facial)
          }
        }
      }
      await Promise.all(
        Array.from(actionNames, (name) => model.internalModel.motionManager.loadMotion(name, 0))
      )

      result.push({
        id: model_data.id,
        model: model
      })
    }
    return result
  }

  public async preloadImages(): Promise<TextureMap[]> {
    const result: TextureMap[] = []

    for (const image of this.storyData.images) {
      const imageUrl = resourceUrl(`images/${image.image}`)

      let texture: Texture<Resource>

      try {
        texture = await Texture.fromURL(imageUrl)
      } catch (error) {
        if (error instanceof Event && error.type === 'error') {
          throw new Error(`Image ${image.id} could not be loaded.\nImage path: ${image.image}\n`)
        }

        throw error
      }

      result.push({
        id: image.id,
        image: texture
      })
    }

    return result
  }

  public geVoiceUrlByName(name: string): string {
    return resourceUrl(`voices/${name}`)
  }

  get snippets(): SnippetData[] {
    return this.storyData.snippets
  }
}
