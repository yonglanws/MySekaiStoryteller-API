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
    // 预先按 modelId 分组收集全部待预加载动作，避免重复扫描整份剧本
    const actionNamesByModel = new Map<number, Set<string>>()
    for (const modelData of this.storyData.models) {
      actionNamesByModel.set(modelData.id, new Set<string>())
    }
    for (const snippet of this.storyData.snippets) {
      // 入场/退场动作也必须预加载：旧代码只扫 Talk/Motion，第一次 LayoutAppear
      // 才去加载动作文件，淡入已经开始了动作还没开始，形成“入场站桩”。
      if (
        snippet.type !== 'Talk' &&
        snippet.type !== 'Motion' &&
        snippet.type !== 'Move' &&
        snippet.type !== 'LayoutAppear' &&
        snippet.type !== 'LayoutClear'
      ) {
        continue
      }
      const ownSet = actionNamesByModel.get(snippet.data.modelId)
      if (ownSet) {
        if (snippet.data.motion) ownSet.add(snippet.data.motion)
        if (snippet.data.facial) ownSet.add(snippet.data.facial)
      }
      if (snippet.type === 'Talk' || snippet.type === 'Motion') {
        for (const action of snippet.data.actions ?? []) {
          const actionSet = actionNamesByModel.get(action.modelId)
          if (!actionSet) continue
          if (action.motion) actionSet.add(action.motion)
          if (action.facial) actionSet.add(action.facial)
        }
      }
    }

    // 并发加载全部模型及其动作文件，保持输出顺序与 storyData.models 一致
    return Promise.all(
      this.storyData.models.map(async (model_data): Promise<Live2DModelMap> => {
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
        const actionNames = actionNamesByModel.get(model_data.id) ?? new Set<string>()
        await Promise.all(
          Array.from(actionNames, (name) => model.internalModel.motionManager.loadMotion(name, 0))
        )

        return {
          id: model_data.id,
          model
        }
      })
    )
  }

  public async preloadImages(): Promise<TextureMap[]> {
    return Promise.all(
      this.storyData.images.map(async (image): Promise<TextureMap> => {
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
        return {
          id: image.id,
          image: texture
        }
      })
    )
  }

  public geVoiceUrlByName(name: string): string {
    return resourceUrl(`voices/${name}`)
  }

  get snippets(): SnippetData[] {
    return this.storyData.snippets
  }
}
