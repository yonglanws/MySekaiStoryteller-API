import { z } from 'zod'

export enum LayoutModes {
  Normal = 'Normal',
  Three = 'Three'
}

export enum Sides {
  Center = 'Center',
  Left = 'Left',
  Right = 'Right',
  LeftOver = 'LeftOver',
  RightOver = 'RightOver',
  Under = 'Under'
}

export type LayoutSide = `${Sides}`

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

export const ProgressBehaviorEnum = z.enum(['Now', 'WaitFinished'])
export type ProgressBehavior = z.infer<typeof ProgressBehaviorEnum>

const ModelSchema = z.object({
  id: z.number(),
  model: z.string(),
  normal_scale: z.number().default(2.1),
  small_scale: z.number().default(1.8),
  anchor: z.number().default(0.5),
  costumes: z.record(z.string(), z.string()).optional()
})

const ImageSchema = z.object({
  id: z.number(),
  image: z.string()
})

const LayoutModeEnum = z.enum(LayoutModes)
const SideEnum = z.enum(Sides)
const MoveSpeedEnum = z.enum(MoveSpeed)
const CurvesEnum = z.enum(Curves)

const LayoutPositionSchema = z.object({
  side: SideEnum,
  offset: z.number().default(0),
  under: z.boolean().optional()
})

const baseSnippetFields = {
  wait: z.boolean().optional(),
  progressBehavior: ProgressBehaviorEnum.optional(),
  delay: z.number().default(0)
}

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

export const SnippetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ChangeLayoutMode'),
    ...baseSnippetFields,
    data: z.object({
      mode: LayoutModeEnum
    })
  }),
  z.object({
    type: z.literal('ChangeBackgroundImage'),
    ...baseSnippetFields,
    data: z.object({
      imageId: z.number(),
      duration: z.number().finite().min(0).max(30000).optional()
    })
  }),
  z.object({
    type: z.literal('ChangeBgm'),
    ...baseSnippetFields,
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
    type: z.literal('BgmVolume'),
    ...baseSnippetFields,
    data: z.object({
      volume: z.number().finite().min(0).max(2),
      duration: z.number().finite().min(0).max(30000)
    })
  }),
  z.object({
    type: z.literal('PlaySe'),
    ...baseSnippetFields,
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
    ...baseSnippetFields,
    data: z.object({
      file: z.string().trim().min(1),
      /** 淡出时长（毫秒）；0 = 立即停止 */
      fadeMs: z.number().finite().min(0).max(10000).default(0)
    })
  }),
  z.object({
    type: z.literal('LayoutAppear'),
    ...baseSnippetFields,
    data: z.object({
      modelId: z.number(),
      from: LayoutPositionSchema,
      to: LayoutPositionSchema,
      motion: z.string(),
      facial: z.string(),
      facialFirst: z.boolean().default(true),
      moveSpeed: MoveSpeedEnum,
      hologram: z.boolean().default(false)
    })
  }),
  z.object({
    type: z.literal('LayoutClear'),
    ...baseSnippetFields,
    data: z.object({
      modelId: z.number(),
      from: LayoutPositionSchema,
      to: LayoutPositionSchema,
      moveSpeed: MoveSpeedEnum,
      /** 退场时的并发身体动作（与滑出同时进行，模型离场后自然中断） */
      motion: z.string().default(''),
      /** 退场时的并发表情（可选） */
      facial: z.string().default('')
    })
  }),
  z.object({
    type: z.literal('LayoutDepth'),
    ...baseSnippetFields,
    data: z.object({
      modelId: z.number(),
      depth: z.enum(['Front', 'Back', 'Reset'])
    })
  }),
  z.object({
    type: z.literal('CharacterShake'),
    ...baseSnippetFields,
    data: z.object({
      modelId: z.number(),
      axis: z.enum(['X', 'Y'])
    })
  }),
  z.object({
    type: z.literal('CostumeChange'),
    ...baseSnippetFields,
    data: z.object({
      modelId: z.number(),
      costume: z.string()
    })
  }),
  z.object({
    type: z.literal('Talk'),
    ...baseSnippetFields,
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
      actions: CharacterActionsSchema,
      /** 官方 TalkData.WhenFinishCloseWindow */
      closeWindowOnFinish: z.boolean().optional(),
      /** 官方 TalkData.RequirePlayEffect */
      effect: z.enum(['Normal', 'Internal', 'Overlap']).optional()
    })
  }),
  z.object({
    type: z.literal('HideTalk'),
    ...baseSnippetFields
  }),
  z.object({
    type: z.literal('Move'),
    ...baseSnippetFields,
    data: z.object({
      modelId: z.number(),
      from: LayoutPositionSchema,
      to: LayoutPositionSchema,
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
    ...baseSnippetFields,
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
    ...baseSnippetFields,
    data: z.object({
      content: z.string()
    })
  }),
  z.object({
    type: z.literal('PlaceInfo'),
    ...baseSnippetFields,
    data: z.object({
      text: z.string(),
      duration: z.number().finite().min(0).max(30000).optional()
    })
  }),
  z.object({
    type: z.literal('FullScreenText'),
    ...baseSnippetFields,
    data: z.object({
      text: z.string(),
      voice: z.string().optional(),
      duration: z.number().finite().min(0).max(120000).optional(),
      keepBars: z.boolean().optional()
    })
  }),
  z.object({
    type: z.literal('SimpleSelectable'),
    ...baseSnippetFields,
    data: z.object({
      choices: z.array(z.string()),
      pickedIndex: z.number().int().min(0).optional()
    })
  }),
  z.object({
    type: z.literal('BlackOut'),
    ...baseSnippetFields,
    data: z.object({
      duration: z.number(),
      /** 画面淡出到黑/白（PJSK 的 BlackOut / WhiteOut），旧故事缺省为黑 */
      color: z.enum(['black', 'white']).default('black')
    })
  }),
  z.object({
    type: z.literal('BlackIn'),
    ...baseSnippetFields,
    data: z.object({
      duration: z.number(),
      /** 从黑/白淡入画面（PJSK 的 BlackIn / WhiteIn） */
      color: z.enum(['black', 'white']).default('black')
    })
  }),
  z.object({
    type: z.literal('ShakeScreen'),
    ...baseSnippetFields,
    data: z.object({
      /** 抖动时长（毫秒，或 <=10 兼容秒） */
      duration: z.number().finite().min(0).max(30000),
      /** 振幅，相对画面高度的比例；PJSK 为 1% */
      amplitude: z.number().finite().min(0).max(0.2).default(0.01),
      intensity: z.number().finite().min(0).max(100).optional()
    })
  }),
  z.object({
    type: z.literal('StopShakeScreen'),
    ...baseSnippetFields,
    data: z.object({}).optional()
  }),
  z.object({
    type: z.literal('ShakeWindow'),
    ...baseSnippetFields,
    data: z
      .object({
        duration: z.number().finite().min(0).max(30000).optional(),
        intensity: z.number().finite().min(0).max(100).optional()
      })
      .default({})
  }),
  z.object({
    type: z.literal('StopShakeWindow'),
    ...baseSnippetFields,
    data: z.object({}).optional()
  }),
  z.object({
    type: z.literal('FlashbackIn'),
    ...baseSnippetFields,
    data: z.object({
      /** 淡入时长（毫秒）；PJSK 固定 100 */
      duration: z.number().finite().min(0).max(10000).default(100),
      /** 暗色滤镜的不透明度；PJSK 为 0.3 */
      alpha: z.number().finite().min(0).max(1).default(0.3)
    })
  }),
  z.object({
    type: z.literal('FlashbackOut'),
    ...baseSnippetFields,
    data: z.object({
      duration: z.number().finite().min(0).max(10000).default(100)
    })
  }),
  z.object({
    type: z.literal('SepiaIn'),
    ...baseSnippetFields,
    data: z
      .object({
        duration: z.number().finite().min(0).max(30000).optional()
      })
      .default({})
  }),
  z.object({
    type: z.literal('SepiaOut'),
    ...baseSnippetFields,
    data: z
      .object({
        duration: z.number().finite().min(0).max(30000).optional()
      })
      .default({})
  }),
  z.object({
    type: z.literal('SekaiIn'),
    ...baseSnippetFields,
    data: z
      .object({
        duration: z.number().finite().min(0).max(30000).optional(),
        variant: z.enum(['v1', 'v2']).optional()
      })
      .default({})
  }),
  z.object({
    type: z.literal('SekaiOut'),
    ...baseSnippetFields,
    data: z
      .object({
        duration: z.number().finite().min(0).max(30000).optional(),
        variant: z.enum(['v1', 'v2']).optional()
      })
      .default({})
  }),
  z.object({
    type: z.literal('Wipe'),
    ...baseSnippetFields,
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
    ...baseSnippetFields,
    data: z
      .object({
        /** 新官方契约字段 */
        direction: z.enum(['Left', 'Right', 'Top', 'Bottom']).optional(),
        /** 旧字段兼容（EffectType 29~36） */
        edge: z.enum(['left', 'right', 'top', 'bottom']).optional(),
        mode: z.enum(['In', 'Out', 'in', 'out']),
        duration: z.number().finite().min(0).max(10000)
      })
      .refine((d) => Boolean(d.direction || d.edge), {
        message: 'SideFade must specify direction or edge'
      })
  }),
  z.object({
    type: z.literal('AttachCharacterShader'),
    ...baseSnippetFields,
    data: z.object({
      modelId: z.number(),
      shader: z.enum(['hologram', 'monitor', 'blur', 'none']),
      level: z.number().finite().min(0).max(10).optional()
    })
  }),
  z.object({
    type: z.literal('PlayScenarioEffect'),
    ...baseSnippetFields,
    data: z.object({
      effectName: z.string(),
      duration: z.number().finite().min(0).max(30000).optional()
    })
  }),
  z.object({
    type: z.literal('StopScenarioEffect'),
    ...baseSnippetFields,
    data: z.object({
      effectName: z.string(),
      duration: z.number().finite().min(0).max(30000).optional()
    })
  }),
  z.object({
    type: z.literal('BlurIn'),
    ...baseSnippetFields,
    data: z.object({
      duration: z.number().finite().min(0).max(30000)
    })
  }),
  z.object({
    type: z.literal('BlurOut'),
    ...baseSnippetFields,
    data: z.object({
      duration: z.number().finite().min(0).max(30000)
    })
  }),
  z.object({
    type: z.literal('CameraMove'),
    ...baseSnippetFields,
    data: z.object({
      /** 相对游戏 1920×1080 舞台的偏移（像素） */
      x: z.number().finite().default(0),
      y: z.number().finite().default(0),
      duration: z.number().finite().min(0).max(30000).default(0),
      ease: z.string().optional()
    })
  }),
  z.object({
    type: z.literal('CameraZoom'),
    ...baseSnippetFields,
    data: z.object({
      /** 相对初始视角的缩放倍率；1 = 不缩放 */
      scale: z.number().finite().positive().max(5),
      duration: z.number().finite().min(0).max(30000).default(0),
      ease: z.string().optional()
    })
  }),
  z.object({
    type: z.literal('DollyZoom'),
    ...baseSnippetFields,
    data: z.object({
      duration: z.number().finite().min(0).max(30000),
      zoom: z.number().finite().positive().max(10),
      ease: z.string().optional()
    })
  }),
  z.object({
    type: z.literal('AmbientColor'),
    ...baseSnippetFields,
    data: z.object({
      /** 人物层的环境色滤镜（PJSK 的 AmbientColor*） */
      mode: z.enum(['normal', 'evening', 'night']).default('normal')
    })
  }),
  z.object({
    type: z.literal('BackgroundBlur'),
    ...baseSnippetFields,
    data: z
      .object({
        /** 新官方契约字段 */
        mode: z.enum(['In', 'Out']).optional(),
        level: z.number().finite().min(0).max(64).optional(),
        duration: z.number().finite().min(0).max(10000).optional(),
        /** 旧字段兼容 */
        enabled: z.boolean().optional()
      })
      .refine((d) => d.mode !== undefined || d.enabled !== undefined, {
        message: 'BackgroundBlur must specify mode or enabled'
      })
  }),
  z.object({
    type: z.literal('StopShake'),
    ...baseSnippetFields
  }),
  z.object({
    type: z.literal('Movie'),
    ...baseSnippetFields,
    data: z.object({
      file: z.string(),
      duration: z.number().finite().min(0).max(600000).optional()
    })
  }),
  z.object({
    type: z.literal('DoParam'),
    ...baseSnippetFields,
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
