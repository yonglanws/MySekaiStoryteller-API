import { z } from 'zod'

export enum LayoutModes {
  Normal = 'Normal',
  Three = 'Three'
}

export enum Sides {
  Center = 'Center',
  Left = 'Left',
  Right = 'Right'
}

export enum MoveSpeed {
  Slow = 'Slow',
  Normal = 'Normal',
  Fast = 'Fast',
  Immediate = 'Immediate'
}

export enum Curves {
  Linear = 'Linear',
  Sine = 'Sine',
  Cosine = 'Cosine'
}

const ModelSchema = z.object({
  id: z.number(),
  model: z.string(),
  normal_scale: z.number().default(2.1),
  small_scale: z.number().default(1.8),
  anchor: z.number().default(0.5)
})

const ImageSchema = z.object({
  id: z.number(),
  image: z.string()
})

const LayoutModeEnum = z.enum(LayoutModes)
const SideEnum = z.enum(Sides)
const MoveSpeedEnum = z.enum(MoveSpeed)
const CurvesEnum = z.enum(Curves)

/** Timed character cues. `at` is a fraction of the containing snippet's duration. */
export const CharacterActionSchema = z
  .object({
    at: z.number().finite().min(0).max(1),
    modelId: z.number().finite().int(),
    motion: z.string().trim().min(1).optional(),
    facial: z.string().trim().min(1).optional()
  })
  .refine((action) => Boolean(action.motion || action.facial), {
    message: 'A character action must specify motion or facial'
  })

const CharacterActionsSchema = z.array(CharacterActionSchema).max(24).optional()
export type CharacterAction = z.infer<typeof CharacterActionSchema>

const SnippetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ChangeLayoutMode'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      mode: LayoutModeEnum
    })
  }),
  z.object({
    type: z.literal('ChangeBackgroundImage'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      imageId: z.number()
    })
  }),
  z.object({
    type: z.literal('ChangeBgm'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      /** 相对 resources/audio/bgm/ 的文件名；stop=true 时为空 */
      file: z.string().default(''),
      /** 在该时间点停止当前 BGM（淡出） */
      stop: z.boolean().default(false),
      /** 切换/停止时的淡入淡出时长（毫秒） */
      fadeMs: z.number().finite().min(0).max(10000).default(600),
      /** 相对音量（PJSK 的 SetBgmVolume）；旧故事缺省为 1，不改变原有混音 */
      volume: z.number().finite().min(0).max(2).default(1)
    })
  }),
  z.object({
    type: z.literal('PlaySe'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 相对 resources/audio/se/ 的文件名 */
      file: z.string().trim().min(1),
      volume: z.number().finite().min(0).max(4).default(1),
      loop: z.boolean().default(false),
      /** 淡入时长（毫秒）；0 = 立即满音量 */
      fadeMs: z.number().finite().min(0).max(10000).default(0)
    })
  }),
  z.object({
    type: z.literal('StopSe'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      file: z.string().trim().min(1),
      /** 淡出时长（毫秒）；0 = 立即停止 */
      fadeMs: z.number().finite().min(0).max(10000).default(0)
    })
  }),
  z.object({
    type: z.literal('LayoutAppear'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      modelId: z.number(),
      from: z.object({
        side: SideEnum,
        offset: z.number().default(0)
      }),
      to: z.object({
        side: SideEnum,
        offset: z.number().default(0)
      }),
      motion: z.string(),
      facial: z.string(),
      facialFirst: z.boolean().default(true),
      moveSpeed: MoveSpeedEnum,
      hologram: z.boolean().default(false)
    })
  }),
  z.object({
    type: z.literal('LayoutClear'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      modelId: z.number(),
      from: z.object({
        side: SideEnum,
        offset: z.number().default(0)
      }),
      to: z.object({
        side: SideEnum,
        offset: z.number().default(0)
      }),
      moveSpeed: MoveSpeedEnum,
      /** 退场时的并发身体动作（与滑出同时进行，模型离场后自然中断） */
      motion: z.string().default(''),
      /** 退场时的并发表情（可选） */
      facial: z.string().default('')
    })
  }),
  z.object({
    type: z.literal('Talk'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      speaker: z.string(),
      content: z.string(),
      modelId: z.number().default(-1),
      voice: z.string().default(''),
      ttsText: z.string().default(''),
      /**
       * 情绪标签（如 平静/开心/生气/伤心/害羞/惊讶）。
       * IrodoriTTS 按角色配置的 emotion 参考音频切换音色；其他 TTS 后端忽略。
       */
      emotion: z.string().default(''),
      /** 说话时的并发身体动作（与台词同时开始，短于台词则自然淡出回基础姿态） */
      motion: z.string().default(''),
      /** 说话时的并发表情切换（可选，缺省保持当前表情） */
      facial: z.string().default(''),
      actions: CharacterActionsSchema
    })
  }),
  z.object({
    type: z.literal('HideTalk'),
    wait: z.boolean(),
    delay: z.number()
  }),
  z.object({
    type: z.literal('Move'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      modelId: z.number(),
      from: z.object({
        side: SideEnum,
        offset: z.number().default(0)
      }),
      to: z.object({
        side: SideEnum,
        offset: z.number().default(0)
      }),
      moveSpeed: MoveSpeedEnum,
      /** 与位移并发的身体动作（PJSK CharacterLayout/Motion） */
      motion: z.string().default(''),
      /** 与位移并发的表情 */
      facial: z.string().default(''),
      facialFirst: z.boolean().default(true)
    })
  }),
  z.object({
    type: z.literal('Motion'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      modelId: z.number(),
      motion: z.string().default(''),
      facial: z.string().default(''),
      facialFirst: z.boolean().default(true),
      /** Silent sequence duration in seconds; only used when actions are present. */
      duration: z.number().finite().positive().max(120).optional(),
      actions: CharacterActionsSchema
    })
  }),
  z.object({
    type: z.literal('Telop'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      content: z.string()
    })
  }),
  z.object({
    type: z.literal('BlackOut'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      duration: z.number(),
      /** 画面淡出到黑/白（PJSK 的 BlackOut / WhiteOut），旧故事缺省为黑 */
      color: z.enum(['black', 'white']).default('black')
    })
  }),
  z.object({
    type: z.literal('BlackIn'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      duration: z.number(),
      /** 从黑/白淡入画面（PJSK 的 BlackIn / WhiteIn） */
      color: z.enum(['black', 'white']).default('black')
    })
  }),
  z.object({
    type: z.literal('ShakeScreen'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 抖动时长（毫秒） */
      duration: z.number().finite().positive().max(30000),
      /** 振幅，相对画面高度的比例；PJSK 为 1% */
      amplitude: z.number().finite().min(0).max(0.2).default(0.01)
    })
  }),
  z.object({
    type: z.literal('FlashbackIn'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 淡入时长（毫秒）；PJSK 固定 100 */
      duration: z.number().finite().min(0).max(10000).default(100),
      /** 暗色滤镜的不透明度；PJSK 为 0.3 */
      alpha: z.number().finite().min(0).max(1).default(0.3)
    })
  }),
  z.object({
    type: z.literal('FlashbackOut'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      duration: z.number().finite().min(0).max(10000).default(100)
    })
  }),
  z.object({
    type: z.literal('Wipe'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 黑色幕布扫过的方向 */
      direction: z.enum(['left', 'right']).default('right'),
      /** in = 从画外扫入覆盖画面；out = 从覆盖状态扫出 */
      mode: z.enum(['in', 'out']).default('in'),
      duration: z.number().finite().min(0).max(10000)
    })
  }),
  z.object({
    type: z.literal('SideFade'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 黑幕从哪一侧覆盖/退出（官方 EffectType 29~36） */
      edge: z.enum(['left', 'right', 'top', 'bottom']),
      /** out = 从该侧滑入覆盖；in = 从覆盖状态向该侧滑出、露出画面 */
      mode: z.enum(['in', 'out']),
      duration: z.number().finite().min(0).max(10000)
    })
  }),
  z.object({
    type: z.literal('CameraMove'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 相对游戏 1920×1080 舞台的偏移（像素） */
      x: z.number().finite().default(0),
      y: z.number().finite().default(0),
      duration: z.number().finite().min(0).max(30000).default(0)
    })
  }),
  z.object({
    type: z.literal('CameraZoom'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 相对初始视角的缩放倍率；1 = 不缩放 */
      scale: z.number().finite().positive().max(5),
      duration: z.number().finite().min(0).max(30000).default(0)
    })
  }),
  z.object({
    type: z.literal('AmbientColor'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 人物层的环境色滤镜（PJSK 的 AmbientColor*） */
      mode: z.enum(['normal', 'evening', 'night']).default('normal')
    })
  }),
  z.object({
    type: z.literal('BackgroundBlur'),
    wait: z.boolean().default(false),
    delay: z.number().default(0),
    data: z.object({
      /** 官方 EffectType 44：背景模糊开关 */
      enabled: z.boolean()
    })
  }),
  z.object({
    type: z.literal('StopShake'),
    wait: z.boolean().default(false),
    delay: z.number().default(0)
  }),
  z.object({
    type: z.literal('DoParam'),
    wait: z.boolean(),
    delay: z.number(),
    data: z.object({
      modelId: z.number(),
      params: z.array(
        z.object({
          paramId: z.string(),
          start: z.number(),
          end: z.number(),
          curve: CurvesEnum,
          duration: z.number()
        })
      )
    })
  })
])

export const StorySchema = z.object({
  models: z.array(ModelSchema),
  images: z.array(ImageSchema),
  snippets: z.array(SnippetSchema)
})

export type ModelData = z.infer<typeof ModelSchema>
export type SnippetData = z.infer<typeof SnippetSchema>
export type StoryData = z.infer<typeof StorySchema>
