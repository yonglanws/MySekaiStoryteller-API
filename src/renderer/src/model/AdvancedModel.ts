import {
  Cubism2InternalModel,
  Cubism4InternalModel,
  Live2DModel,
  MotionPriority
} from 'pixi-live2d-display-advanced'
import AnimationManager from '../managers/AnimationManager'
import PositionRel from '../types/PositionRel'
import { CharacterAction, ModelData } from '../../../common/types/Story'
import { VisualEffectManager } from '../managers/VisualEffectManager'
import { AlphaFilter, Filter } from 'pixi.js'
import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../utils/Logger'
import { motionTrace } from '../managers/video-export/MotionTraceCollector'
import {
  advancePlayableBlendLayer,
  bodyBlendSeconds,
  changePlayableBlendLayer,
  clearPlayableBlendLayer,
  createPlayableBlendLayer,
  evaluateBlendedLayerValues,
  facialBlendSeconds,
  type EvaluatedBlendInput,
  type PlayableBlendLayer
} from './MotionBlend'
import {
  advanceBreathDegree,
  bodyMotionChangedBlink,
  bodyMotionFinishedBlink,
  breathParameterValue,
  createBlinkState,
  createBreathDegree,
  invokeBlinkUserData,
  missingBodyMotionBlink,
  naturalMotionSeed,
  sleepBlink,
  stepBlink,
  type BlinkState
} from './NaturalMotion'
import {
  BODY_MOTION_FADE_SECONDS,
  CHARACTER_SHAKE_MS,
  FACIAL_FADE_SECONDS,
  LIP_LOUD_CHARACTERS,
  LIP_LOUD_TARGET_VALUE_SCALE,
  LIP_TARGET_VALUE_SCALE,
  STORY_FPS,
  msToFrameCount
} from '../../../common/official/timing'
import { interpolatePosition } from '../../../common/official/layoutMotion'
import { registerClockBaselineResetListener } from '../snippets/stageTiming'

const MODEL_PREFIX_STANDING_RE = /(?:^|-)(?:default|stand|blushed)\d*$/i
const NON_EYE_OPEN_FACIAL_PARAM_RE =
  /^(?:Param(?:Brow|Eye(?!LOpen$|ROpen$|Ball|ball)|Mouth(?!OpenY$)|Cheek|Tear|Sweat|FaceShadow|Teeth|Kirakira|SpecialEye|Highlight|Cry|Eyelid|Darkcycle|ReflectedLight)|PARAM_(?:BROW|EYE_(?!L_OPEN$|R_OPEN$|BALL)|MOUTH_(?!OPEN_Y$)|CHEEK|TEAR|SWEAT))/i

/**
 * Normalizes a PJSK body motion name into its motion family prefix so v1 (`w-normal-nod01`),
 * v2 (`w-normal01-nod`), `l-*` (`l-night03-sigh`), and compound char tags (`w-normal07cool02-think`)
 * all group consistently for chain/variation selection.
 */
export function motionFamilyKey(name: string): string {
  const parts = String(name ?? '')
    .trim()
    .split('-')
    .filter(Boolean)
  if (parts.length >= 2) {
    const seg1 = parts[0]
    const seg2 = parts[1]
    const normalizedSeg2 = seg2.replace(/\d+.*$/, '') || seg2.replace(/\d+$/, '') || seg2
    return `${seg1}-${normalizedSeg2}`
  }
  return String(name ?? '').trim()
}

/**
 * 素材库里混有两种 Cubism 参数 ID 命名：Cubism2 风格全大写下划线（PARAM_ARM_R_1）
 * 与 Cubism4 驼峰（ParamArmR1）。ID 与模型对不上的动作会正常"启动"（startMotion
 * 返回 true），但写不进任何模型参数——表现为动作完全无响应。同一别名组内的 ID
 * 指同一逻辑参数；加载动作时按模型实际 ID 集合归一化。
 */
const MOTION_ID_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['PARAM_ANGLE_X', 'ParamAngleX'],
  ['PARAM_ANGLE_Y', 'ParamAngleY'],
  ['PARAM_ANGLE_Z', 'ParamAngleZ'],
  ['PARAM_EYE_L_OPEN', 'ParamEyeLOpen'],
  ['PARAM_EYE_R_OPEN', 'ParamEyeROpen'],
  ['PARAM_EYE_BALL_X', 'PARAM_EYEBALL_X', 'ParamEyeBallX', 'ParamEyeballX'],
  ['PARAM_EYE_BALL_Y', 'PARAM_EYEBALL_Y', 'ParamEyeBallY', 'ParamEyeballY'],
  ['PARAM_EYE_L_SMILE', 'ParamEyeLSmile'],
  ['PARAM_EYE_R_SMILE', 'ParamEyeRSmile'],
  ['PARAM_BROW_L_X', 'ParamBrowLX'],
  ['PARAM_BROW_R_X', 'ParamBrowRX'],
  ['PARAM_BROW_L_Y', 'ParamBrowLY'],
  ['PARAM_BROW_R_Y', 'ParamBrowRY'],
  ['PARAM_BROW_L_FORM', 'ParamBrowLForm'],
  ['PARAM_BROW_R_FORM', 'ParamBrowRForm'],
  ['PARAM_MOUTH_OPEN_Y', 'ParamMouthOpenY'],
  ['PARAM_MOUTH_FORM', 'ParamMouthForm'],
  ['PARAM_BODY_ANGLE_X', 'ParamBodyAngleX'],
  ['PARAM_BODY_ANGLE_Y', 'ParamBodyAngleY'],
  ['PARAM_BODY_ANGLE_Z', 'ParamBodyAngleZ'],
  ['PARAM_BREATH', 'ParamBreath'],
  ['PARAM_POSITION_X', 'ParamPositionX'],
  ['PARAM_POSITION_Y', 'ParamPositionY'],
  ['PARAM_ROTATION_Z', 'ParamRotationZ'],
  ['PARAM_UPPER_BODY', 'ParamUpperBody'],
  ['PARAM_UPPER_BODY_Z', 'ParamUpperBodyZ'],
  ['PARAM_SHOULDER_L', 'ParamShoulderL'],
  ['PARAM_SHOULDER_R', 'ParamShoulderR'],
  ['PARAM_LEG_L_Z', 'ParamLegLZ'],
  ['PARAM_LEG_R_Z', 'ParamLegRZ'],
  ['PARAM_FINGER_L', 'ParamFingerL'],
  ['PARAM_FINGER_R', 'ParamFingerR']
]

const MOTION_PARAMETER_ID_ALIASES: Map<string, readonly string[]> = (() => {
  const map = new Map<string, readonly string[]>()
  const add = (group: readonly string[]): void => {
    for (const id of group)
      map.set(
        id,
        group.filter((candidate) => candidate !== id)
      )
  }
  for (const group of MOTION_ID_ALIAS_GROUPS) add(group)
  for (let i = 1; i <= 9; i++) {
    add([`PARAM_ARM_L_${i}`, `ParamArmL${i}`])
    add([`PARAM_ARM_R_${i}`, `ParamArmR${i}`])
  }
  for (const suffix of 'ABCDEFGHIJK') {
    add([`PARAM_HAND_L_${suffix}`, `ParamHandL${suffix}`])
    add([`PARAM_HAND_R_${suffix}`, `ParamHandR${suffix}`])
  }
  return map
})()

export default class AdvancedModel extends Live2DModel {
  /**
   * 表演续演间隔（毫秒），由宿主配置下发（video.idleChainGapSec）。
   * 0 = 关闭续演：动作播完保持结束时的姿势（不回落站立），直到下一个 cue。
   * >0 = 间隔（±25% 抖动）后再接一个同情绪族手势。
   */
  public static idleChainGapMs = 0

  private static readonly liveInstances = new Set<AdvancedModel>()

  public static resetAllClockBaselines(now = performance.now()): void {
    for (const model of AdvancedModel.liveInstances) {
      if (!model.destroyed) {
        model.resetClockBaselines(now)
      }
    }
  }

  public autoBlink: boolean = true
  public lastChangeBlinkTime: number | null = null
  public readonly visualEffectManager: VisualEffectManager = new VisualEffectManager(this)
  private readonly channelGeneration = [0, 0]
  /** 每个通道下一次 startMotion 的交叉淡化秒数（由官方混合规则计算）。 */
  private readonly channelFadeSeconds: [number, number] = [
    BODY_MOTION_FADE_SECONDS,
    FACIAL_FADE_SECONDS
  ]
  private blinkState: BlinkState = createBlinkState(1)
  private breathDegree = 0
  private breathParamId: string | null = null
  private mouthOpenParamIds: string[] = []
  private mouthOpenIndices = new Map<string, number>()
  /** 本帧要画进网格的开度；null 表示没有口型覆盖。 */
  private pendingMouthOpen: number | null = null
  private mouthUpdateHooked = false
  private mouthParamCount = 0
  private mouthFormParamId: string | null = null
  private mouthFormIndex = -1
  private mouthFormRange: { min: number; max: number; defaultValue: number } | null = null
  private naturalMotionInstalled = false
  private lastNaturalUpdateMs = 0
  private firstBodyCue = true
  private facialForceNext = false
  private oneShotWaitDepth = 0
  private bodyAllowEyeOverride = false
  private modelParamIds: Set<string> | null = null
  private readonly channelHeldEntries: [WeakSet<object>, WeakSet<object>] = [
    new WeakSet<object>(),
    new WeakSet<object>()
  ]
  private readonly channelFinishFiredEntries: [WeakSet<object>, WeakSet<object>] = [
    new WeakSet<object>(),
    new WeakSet<object>()
  ]
  private readonly channelEntryCounts = [0, 0]
  private playableLayers: [PlayableBlendLayer<object>, PlayableBlendLayer<object>] = [
    createPlayableBlendLayer<object>(),
    createPlayableBlendLayer<object>()
  ]
  private playableLayerLastTime: [number | null, number | null] = [null, null]
  private channelAnimatedParamIndices: [Set<number>, Set<number>] = [
    new Set<number>(),
    new Set<number>()
  ]
  private lastBodyEvaluatedIndices = new Set<number>()
  private blinkUserDataHookedQueues = new WeakSet<object>()
  private bodyIgnoredParamIds: string[] = []
  private restoreBodyUpdate: (() => void) | null = null
  private restoreFacialUpdate: (() => void) | null = null
  private facialManagedParamIds: Set<string> = new Set<string>()
  private defaultParamValues: Map<string, number> = new Map<string, number>()
  private readonly actionController = new AbortController()
  private defaultMotionName: string | null = null
  private defaultFacialName: string | null = null
  private bodyChainArmed = false
  private bodyChainGeneration = -1
  private bodyChainTimer: ReturnType<typeof setTimeout> | null = null
  private recentBodyMotions: string[] = []
  private currentBodyMotion: string | null = null
  private currentBodySnippetIndex = -1
  private currentFacialName: string | null = null
  private currentBodyStartedAt = 0
  private currentBodyClipDurationMs = 0
  private bodyFinishReported = true

  /** Aborted when this model is destroyed; suitable for a snippet action scope. */
  public get actionSignal(): AbortSignal {
    return this.actionController.signal
  }

  private _metadata: ModelData | null = null

  private inHologram: boolean = false

  private logger: Logger<ILogObj> = getSubLogger('AdvancedModel[Uninitialized]')

  get metadata(): ModelData {
    return this._metadata!
  }

  public initialize(metadata: ModelData): void {
    if (!this._metadata) {
      this._metadata = metadata
    } else {
      throw new Error('Initialize model metadata more than once.')
    }
    this.visible = true
    AdvancedModel.liveInstances.add(this)
    this.internalModel.extendParallelMotionManager(2)
    this.neutralizeDrawableColors()
    this.modelParamIds = this.resolveCoreParameterIds()
    this.seedDefaultParameterValues()
    this.collectPreloadedFacialParams()
    this.resolveMouthParams()
    this.installMotionIdNormalization()
    this.installMotionLoopHook()
    this.installHoldLastFrameHook(0)
    this.installHoldLastFrameHook(1)
    this.installBodyParameterIsolation()
    this.installFacialDefaultReset()
    this.installCrossfade(0)
    this.installCrossfade(1)

    this.internalModel.parallelMotionManager[0].stopAllMotions()
    this.internalModel.parallelMotionManager[1].stopAllMotions()

    // 官方模型先用别的方式驱动眨眼与呼吸；这里关掉依赖自带的 eyeBlink 与 3.2345s breath
    // （Cubism4InternalModel.init 里 ParamBreath 不受 breathDepth:0 影响），统一改由 NaturalMotion 控制。
    const internalWithNatural = this.internalModel as unknown as {
      eyeBlink?: unknown
      breath?: unknown
    }
    internalWithNatural.eyeBlink = undefined
    internalWithNatural.breath = undefined

    const seed = naturalMotionSeed(metadata.id)
    this.blinkState = createBlinkState(seed)
    // `BuildModelComponent`: `breathDegree = Random.Range(0, 360)`（int 重载），整数初值。
    this.breathDegree = createBreathDegree(seed)
    sleepBlink(this.blinkState)

    const motionManager = this.internalModel.motionManager
    const groups = motionManager.motionGroups
    const defaultMotion = groups && groups['w-normal-default01'] ? 'w-normal-default01' : null
    const defaultFacial = groups && groups['face_normal_01'] ? 'face_normal_01' : null
    this.defaultMotionName = defaultMotion
    this.defaultFacialName = defaultFacial

    // 新模型的第一段 clip 没有可混合的旧姿势，官方 blend=0。
    this.channelFadeSeconds[0] = 0
    this.channelFadeSeconds[1] = 0
    // 不在这里异步启动默认 body/facial：initialize 是同步的，startMotion 的加载
    // 完成时机不可控。第一段 LayoutAppear 常请求同一个 face_normal_01，会和这里的
    // 异步 default facial 抢 MotionState 的 reservation，导致表情 cue 被拒绝。
    // 官方新模型本来也没有默认动作；第一段 cue（或 startEntryMotion 兜底）负责启动。
    this.firstBodyCue = true

    const alpha_filter = new AlphaFilter(0)
    this.alphaFilter = alpha_filter
    this.modelOpacity = 0

    this.filters = [alpha_filter]

    this.anchor.x = 0.5
    this.anchor.y = this.metadata.anchor

    this.visualEffectManager.createAll()
    this.installNaturalMotion()

    this.logger = getSubLogger(`AdvancedModel(${this._metadata.id})`)
  }

  /**
   * 参考 `sse-live2d-render/src/live2d.wgsl:cubism_fs` 明确不应用 per-drawable
   * multiply / screen 色（JP 7.0.0 客户端的 CubismRenderer 没有这两个通道）。
   * pixi-live2d 的 Cubism4 渲染器会读取 moc3 里的颜色，未来模型/服装可能因此
   * 多压一层暗部；这里把两个通道钉成中性，只保留普通 baseColor/opacity/mask。
   * 本话 model 21 的 272 个 drawable 实测均为中性（nonNeutral=0），
   * 所以这项不改变 3400 的像素，属于参考对齐兜底，而不是本轮色差的原因。
   */
  private neutralizeDrawableColors(): void {
    const core = this.internalModel?.coreModel as unknown as {
      getDrawableCount?: () => number
      getDrawableMultiplyColor?: (index: number) => { R: number; G: number; B: number; A: number }
      getDrawableScreenColor?: (index: number) => { R: number; G: number; B: number; A: number }
      getMultiplyColor?: (index: number) => unknown
      getScreenColor?: (index: number) => unknown
    }
    if (!core || typeof core.getMultiplyColor !== 'function') return

    const count = Math.max(0, core.getDrawableCount?.() ?? 0)
    let nonNeutral = 0
    for (let index = 0; index < count; index++) {
      const multiply = core.getDrawableMultiplyColor?.(index)
      const screen = core.getDrawableScreenColor?.(index)
      if (
        (multiply &&
          (Math.abs(multiply.R - 1) > 1e-4 ||
            Math.abs(multiply.G - 1) > 1e-4 ||
            Math.abs(multiply.B - 1) > 1e-4)) ||
        (screen &&
          (Math.abs(screen.R) > 1e-4 || Math.abs(screen.G) > 1e-4 || Math.abs(screen.B) > 1e-4))
      ) {
        nonNeutral++
      }
    }
    this.logger.info('Drawable multiply/screen colours neutralized', {
      modelId: this._metadata?.id,
      drawableCount: count,
      nonNeutral
    })

    const neutralMultiply = { R: 1, G: 1, B: 1, A: 1 }
    const neutralScreen = { R: 0, G: 0, B: 0, A: 0 }
    core.getMultiplyColor = () => neutralMultiply
    core.getScreenColor = () => neutralScreen
  }

  /**
   * 把依赖的平行动作队列改成官方 `PlayableAnimator` 语义：
   * 新 clip 与旧 clip 交叉淡化，而不是每次 `stopAllMotions()` 把旧姿势直接丢掉。
   * `ParallelMotionManager._startMotion` 内部会先 stopAll，这里绕开它，
   * 直接调用 queueManager.startMotion，让旧 entry 按 fadeOut 自然退出。
   */
  private installCrossfade(channel: 0 | 1): void {
    const manager = this.internalModel.parallelMotionManager[channel] as unknown as {
      queueManager?: {
        startMotion: (motion: unknown, autoDelete: boolean, now: number) => number
        stopAllMotions?: () => void
        _motions?: Array<{
          _motion?: { setFadeOutTime?: (seconds: number) => void }
          setFadeOut?: (seconds: number) => void
        }>
      }
      _startMotion?: (
        motion: unknown,
        onFinish?: () => void,
        ignoreParamIds?: string[]
      ) => number | void
    }
    if (!manager?.queueManager || typeof manager._startMotion !== 'function') return
    const fallback = manager._startMotion.bind(manager)
    manager._startMotion = (motion, onFinish, ignoreParamIds) => {
      const fade = Math.max(0, this.channelFadeSeconds[channel])
      try {
        const typedMotion = motion as {
          setFadeInTime?: (seconds: number) => void
          setFinishedMotionHandler?: (handler?: () => void) => void
          onFinishHandler?: () => void
          _motionData?: { curves?: Array<{ id: string }>; curveCount?: number }
          motions?: Array<{ _$4P?: string }>
        }
        if (typedMotion.setFadeInTime) typedMotion.setFadeInTime(fade)
        if (typedMotion.setFinishedMotionHandler) typedMotion.setFinishedMotionHandler(onFinish)
        if ('onFinishHandler' in typedMotion) typedMotion.onFinishHandler = onFinish
        if (ignoreParamIds?.length) {
          if (typedMotion._motionData?.curves) {
            typedMotion._motionData.curves = typedMotion._motionData.curves.filter(
              (curve) => !ignoreParamIds.includes(curve.id)
            )
            typedMotion._motionData.curveCount = typedMotion._motionData.curves.length
          } else if (typedMotion.motions) {
            typedMotion.motions = typedMotion.motions.filter(
              (item) => !ignoreParamIds.includes(item._$4P ?? '')
            )
          }
        }
        const queue = manager.queueManager!
        // fade === 0（force / 首段动作）直接清掉旧队列，避免旧 entry 因 endTime === now 多留一帧幽灵姿态。
        if (fade <= 0) {
          queue.stopAllMotions?.()
        }
        const handle = queue.startMotion(motion, false, performance.now())
        // startMotion 会先把旧 entry 的 fadeOut 设成旧 clip 自己的值；这里把 entry 与旧 motion 的
        // _fadeOutSeconds 同步成新 blend，避免 ACubismMotion 用旧 _fadeOutSeconds 除导致首帧权重突跳。
        const entries = queue._motions
        if (fade > 0 && Array.isArray(entries)) {
          for (let i = 0; i < entries.length - 1; i++) {
            const oldEntry = entries[i]
            oldEntry?._motion?.setFadeOutTime?.(fade)
            oldEntry?.setFadeOut?.(fade)
          }
        }
        const newestEntry =
          Array.isArray(entries) && entries.length > 0 ? entries[entries.length - 1] : null
        if (newestEntry) {
          changePlayableBlendLayer(this.getPlayableLayer(channel), newestEntry, fade)
        }
        return handle
      } catch (error) {
        this.logger.warn('Crossfade start failed, falling back to queue stop', error)
        return fallback(motion, onFinish, ignoreParamIds)
      }
    }
  }

  /**
   * 官方 LateUpdate 的自然动作：眨眼（动作期间 Sleep，动作结束 Wake）与 3s 呼吸。
   * 监听 `beforeModelUpdate`：此时动作/物理已经求值，写进去的参数会进入本帧 model.update()。
   *
   * 眼参数无条件乘 `EyeOpening`（`CubismEyeBlinkController` 的 Multiply 混合），
   * 不再按 base>0.25 判断，也不因眼睛本来闭着就冻结 `untilTime`。
   */
  private installNaturalMotion(): void {
    if (this.naturalMotionInstalled) return
    this.naturalMotionInstalled = true
    const internal = this.internalModel as unknown as {
      on: (event: 'beforeModelUpdate', listener: () => void) => void
      coreModel: {
        getParameterIndex?: (id: string) => number
        getParameterValueById?: (id: string) => number
        setParameterValueById?: (id: string, value: number) => void
        getParamFloat?: (id: string) => number
        setParamFloat?: (id: string, value: number) => void
      }
    }
    const core = internal.coreModel
    const has = (id: string): boolean =>
      typeof core?.getParameterIndex === 'function' ? core.getParameterIndex(id) >= 0 : true
    const eyeIds = this.eyeParameterIds()
      .slice(0, 2)
      .filter((id) => has(id))
    const breathCandidates = ['ParamBreath', 'PARAM_BREATH']
    this.breathParamId = breathCandidates.find((id) => has(id)) ?? null
    if (!eyeIds.length && !this.breathParamId) return
    this.lastNaturalUpdateMs = performance.now()
    internal.on('beforeModelUpdate', () => {
      const now = performance.now()
      if (now < this.lastNaturalUpdateMs) {
        this.lastNaturalUpdateMs = now
      }
      // 导出时帧泵按固定 1/60 故事步驱动 Ticker.shared，直接用步长而不是墙钟差，
      // 避免 16/17ms 抖动影响眨眼与呼吸的相位。
      const dt = AnimationManager.isExporting()
        ? 1 / STORY_FPS
        : Math.min(0.25, Math.max(0, (now - this.lastNaturalUpdateMs) / 1000))
      this.lastNaturalUpdateMs = now
      if (this.destroyed) return
      // 官方 `ModelRuntime::update` 的 active 对应模型是否在台显示（含 Appear 淡入与 Clear 淡出期间），
      // 不按 alpha<=0.01 冻结，避免淡入首帧/低 alpha 帧出现呼吸跳变。
      const active = Boolean(this.visible) && this.parent !== null
      if (this.autoBlink !== false && eyeIds.length > 0) {
        const opening = stepBlink(this.blinkState, dt, active)
        if (active) {
          const bases = eyeIds.map(
            (id) => core.getParameterValueById?.(id) ?? core.getParamFloat?.(id) ?? 1
          )
          for (let idx = 0; idx < eyeIds.length; idx++) {
            const id = eyeIds[idx]
            const next = bases[idx] * opening
            if (core.setParameterValueById) core.setParameterValueById(id, next)
            else core.setParamFloat?.(id, next)
          }
        }
      }
      if (this.breathParamId && active) {
        this.breathDegree = advanceBreathDegree(this.breathDegree, dt)
        const value = breathParameterValue(this.breathDegree)
        if (core.setParameterValueById) core.setParameterValueById(this.breathParamId, value)
        else core.setParamFloat?.(this.breathParamId, value)
      }
    })
    this.installBlinkUserData()
  }

  /**
   * 动作的 `UserData`（`OnLive2DInvokeUserData`，例如 `eyeblink,0.2,0.24,0.24`）
   * 由 pixi 的 `MotionQueueManager` 读到后以回调发出；身体/表情实际跑在
   * `parallelMotionManager[0/1]` 上，必须同时挂钩两个并行队列与主 `motionManager`。
   */
  private installBlinkUserData(): void {
    type QueueWithCallback = {
      setEventCallback?: (
        callback: (caller: unknown, value: string, data: unknown) => void,
        customData?: unknown
      ) => void
      _eventCallBack?: (caller: unknown, value: string, data: unknown) => void
      _eventCustomData?: unknown
    }
    const internal = this.internalModel as unknown as {
      motionManager?: { queueManager?: QueueWithCallback }
      parallelMotionManager?: Array<{ queueManager?: QueueWithCallback }>
    }
    const hooked = (this.blinkUserDataHookedQueues ??= new WeakSet<object>())
    const queues: Array<QueueWithCallback | undefined> = [
      internal?.motionManager?.queueManager,
      internal?.parallelMotionManager?.[0]?.queueManager,
      internal?.parallelMotionManager?.[1]?.queueManager
    ]
    for (const queue of queues) {
      if (!queue || typeof queue.setEventCallback !== 'function' || hooked.has(queue)) continue
      hooked.add(queue)
      const original = queue._eventCallBack
      queue.setEventCallback((caller, value, data) => {
        original?.(caller, value, data)
        if (typeof value === 'string') invokeBlinkUserData(this.blinkState, value)
      }, queue._eventCustomData)
    }
  }

  private resolveCoreParameterIds(): Set<string> | null {
    const core = (
      this.internalModel as unknown as {
        coreModel?: { _parameterIds?: string[]; parameters?: { ids?: string[] } }
      }
    )?.coreModel
    const ids = core?._parameterIds ?? core?.parameters?.ids
    return Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null
  }

  /**
   * 口型目标参数在官方是 `LipSync` 组，但 PJSK 的 model3.json 里该组为空
   * （`Groups: [{Name:"LipSync", Ids:[]}]`），所以按模型实际参数 ID 兜底。
   * `ParamMouthForm` 在说话时按官方 AdvCalm 规则小幅中和，避免"咧嘴说话"。
   */
  private resolveMouthParams(): void {
    const isC2 = this.internalModel instanceof Cubism2InternalModel
    const groupIds = (this.internalModel.motionManager as unknown as { lipSyncIds?: string[] })
      ?.lipSyncIds
    const openCandidates = [
      ...(Array.isArray(groupIds) ? groupIds : []),
      isC2 ? 'PARAM_MOUTH_OPEN_Y' : 'ParamMouthOpenY'
    ]
    this.mouthOpenParamIds = [
      ...new Set(this.filterToExistingModelParams(openCandidates.filter(Boolean)))
    ]
    const formId = isC2 ? 'PARAM_MOUTH_FORM' : 'ParamMouthForm'
    this.mouthFormParamId = this.filterToExistingModelParams([formId])[0] ?? null
    this.mouthFormIndex = -1
    this.mouthFormRange = null
    this.mouthOpenIndices.clear()
    this.mouthParamCount = 0
    if (!(this.internalModel instanceof Cubism4InternalModel)) return
    const openCore = this.internalModel.coreModel as unknown as {
      getParameterIndex?: (id: string) => number
      getParameterCount?: () => number
    }
    this.mouthParamCount = openCore.getParameterCount?.() ?? 0
    for (const id of this.mouthOpenParamIds) {
      const index = openCore.getParameterIndex?.(id) ?? -1
      if (index >= 0 && index < this.mouthParamCount) this.mouthOpenIndices.set(id, index)
    }
    if (!this.mouthFormParamId) return
    const core = this.internalModel.coreModel as unknown as {
      getParameterIndex?: (id: string) => number
      getParameterCount?: () => number
      getParameterMinimumValue?: (index: number) => number
      getParameterMaximumValue?: (index: number) => number
      getParameterDefaultValue?: (index: number) => number
    }
    const index = core.getParameterIndex?.(this.mouthFormParamId) ?? -1
    const count = core.getParameterCount?.() ?? 0
    if (index < 0 || index >= count) return
    const min = core.getParameterMinimumValue?.(index)
    const max = core.getParameterMaximumValue?.(index)
    const defaultValue = core.getParameterDefaultValue?.(index)
    if (
      typeof min !== 'number' ||
      typeof max !== 'number' ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      max <= min
    ) {
      return
    }
    this.mouthFormIndex = index
    this.mouthFormRange = {
      min,
      max,
      defaultValue:
        typeof defaultValue === 'number' && Number.isFinite(defaultValue) ? defaultValue : 0
    }
  }

  /** 说话时驱动开度的参数（通常只有 ParamMouthOpenY）。 */
  public getMouthOpenParamIds(): string[] {
    return [...this.mouthOpenParamIds]
  }

  /**
   * 0..1 的口型开度写入模型参数的 min..max；Cubism2 参数本身是 0..1。
   *
   * Cubism4 绘制用的网格在 `coreModel.update()` 里定稿，顺序是
   * updateMotions → saveParameters → beforeModelUpdate → model.update() →
   * loadParameters()。loadParameters 只把参数还原给下一帧的动作混合，
   * 写在它后面进不了本帧网格。听者自己的 updateMotions 又会在自己绘制前
   * 把动作里的张嘴写回来，所以必须挂在这个模型自己的 `model.update()` 之前。
   */
  public setMouthOpening(value: number): void {
    const open = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
    if (this.mouthOpenParamIds.length === 0) return
    const internal = this.internalModel
    const core = internal?.coreModel as { update?: () => void } | undefined
    if (!core || typeof core.update !== 'function') {
      this.writeMouthOpeningNow(open)
      return
    }
    this.pendingMouthOpen = open
    // 先写一次：没有真实 update 循环的调用方（测试）也能读到开度。
    // 真正绘制时在 coreModel.update() 之前再用 pending 值覆盖动作张嘴。
    this.writeMouthOpeningNow(open)
    if (this.mouthUpdateHooked) return
    const original = core.update
    core.update = () => {
      if (this.pendingMouthOpen !== null) {
        this.writeMouthOpeningNow(this.pendingMouthOpen)
      }
      return original.call(core)
    }
    this.mouthUpdateHooked = true
  }

  /**
   * 官方 `Lip::None`：口型脱手。清掉本帧待写的开度，包装过的 `coreModel.update()`
   * 不再重写 `ParamMouthOpenY`，参数回到动作/表情/默认值。
   */
  public releaseMouth(): void {
    this.pendingMouthOpen = null
  }

  private writeMouthOpeningNow(open: number): void {
    const internal = this.internalModel
    if (internal instanceof Cubism4InternalModel) {
      const core = internal.coreModel as unknown as {
        getParameterIndex?: (id: string) => number
        getParameterCount?: () => number
        getParameterMinimumValue?: (index: number) => number
        getParameterMaximumValue?: (index: number) => number
        setParameterValueById: (id: string, value: number) => void
      }
      for (const id of this.mouthOpenParamIds) {
        const index = this.mouthOpenIndices.get(id) ?? core.getParameterIndex?.(id) ?? -1
        const count = this.mouthParamCount || (core.getParameterCount?.() ?? 0)
        if (index >= 0 && index < count) {
          const min = core.getParameterMinimumValue?.(index)
          const max = core.getParameterMaximumValue?.(index)
          if (
            typeof min === 'number' &&
            typeof max === 'number' &&
            Number.isFinite(min) &&
            Number.isFinite(max) &&
            max > min
          ) {
            core.setParameterValueById(id, min + (max - min) * open)
            continue
          }
        }
        core.setParameterValueById(id, open)
      }
      return
    }
    if (internal instanceof Cubism2InternalModel) {
      for (const id of this.mouthOpenParamIds) {
        internal.coreModel.setParamFloat(id, open)
      }
    }
  }

  /**
   * 当前 `ParamMouthForm` 状态；用于说话时按开度向默认值中和。
   * 返回 null 表示模型没有这个参数。
   */
  public getMouthFormInfo(): {
    value: number
    min: number
    max: number
    defaultValue: number
  } | null {
    if (!this.mouthFormParamId) return null
    const internal = this.internalModel
    if (internal instanceof Cubism4InternalModel) {
      if (this.mouthFormIndex < 0 || !this.mouthFormRange) return null
      const core = internal.coreModel as unknown as {
        getParameterValueByIndex?: (index: number) => number
        getParameterValueById?: (id: string) => number
      }
      const value =
        core.getParameterValueByIndex?.(this.mouthFormIndex) ??
        core.getParameterValueById?.(this.mouthFormParamId)
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return { value, ...this.mouthFormRange }
    }
    if (internal instanceof Cubism2InternalModel) {
      const value = internal.coreModel.getParamFloat(this.mouthFormParamId)
      if (!Number.isFinite(value)) return null
      return { value, min: -1, max: 1, defaultValue: 0 }
    }
    return null
  }

  public setMouthForm(value: number): void {
    const info = this.getMouthFormInfo()
    if (!info) return
    const clamped = Math.min(
      info.max,
      Math.max(info.min, Number.isFinite(value) ? value : info.defaultValue)
    )
    if (this.internalModel instanceof Cubism4InternalModel) {
      this.internalModel.coreModel.setParameterValueById(this.mouthFormParamId!, clamped)
    } else if (this.internalModel instanceof Cubism2InternalModel) {
      this.internalModel.coreModel.setParamFloat(this.mouthFormParamId!, clamped)
    }
  }

  /**
   * 场景 cue 的动作一律单次播放后定格（官方 PlayableAnimator 语义）。
   *
   * PJSK 的 motion3.json 全部带 `Meta.Loop = true`，但那是给游戏内 idle 用的；
   * 之前按 Meta.Loop 打开原生循环，结果每个身体动作每 2~3 秒从头再播一次：
   * 2026-11-25 实测 `w-normal-trouble01`（2.6s）在 36.4/39.0/41.6/44.2s 出现
   * 4~6 YAVG 的定格跳变，观感就是“动作突然重启”。旧版渲染器不读 Meta.Loop，
   * 动作播完自然回到 idle，用户对照的样例渲染同样是这种表现。
   * 所以这里无条件关掉循环，让 `installHoldLastFrameHook` 把末帧定住。
   */
  private installMotionLoopHook(): void {
    const motionManager = this.internalModel?.motionManager as unknown as {
      createMotion?: (data: unknown, group: string, definition: unknown) => unknown
    }
    if (!motionManager || typeof motionManager.createMotion !== 'function') return
    const originalCreate = motionManager.createMotion.bind(motionManager)
    motionManager.createMotion = (data: unknown, group: string, definition: unknown) => {
      const motion = originalCreate(data, group, definition)
      this.syncMotionLoopFlag(motion)
      return motion
    }
  }

  private syncMotionLoopFlag(motion: unknown): void {
    const typed = motion as {
      setIsLoop?: (loop: boolean) => void
    } | null
    if (!typed) return
    typed.setIsLoop?.(false)
  }

  /**
   * Keeps the latest non-looping clip on a channel pinned at its last frame indefinitely
   * instead of fading out and getting spliced from the motion queue after 1-2s.
   * Crucially, manager.isFinished() reports true once end-of-clip is reached so Talk gates
   * and finish telemetry fire cleanly while the pose/expression remains held until the next cue
   * crossfades it out.
   */
  private installHoldLastFrameHook(channel: 0 | 1): void {
    const manager = this.internalModel?.parallelMotionManager?.[channel] as unknown as {
      isFinished?: () => boolean
      queueManager?: {
        _motions?: Array<{
          _motion?: {
            _motionData?: { duration?: number; loop?: boolean }
            _loopDurationSeconds?: number
            _isLoop?: boolean
            isLoop?: () => boolean
            getDuration?: () => number
            _onFinishedMotion?: (motion: unknown) => void
          }
          isStarted?: () => boolean
          isFinished?: () => boolean
          isTriggeredFadeOut?: () => boolean
          getStartTime?: () => number
          setStartTime?: (t: number) => void
          getFadeInStartTime?: () => number
          setFadeInStartTime?: (t: number) => void
          getEndTime?: () => number
          setEndTime?: (t: number) => void
          setLastCheckEventSeconds?: (t: number) => void
        } | null>
        doUpdateMotion?: (model: unknown, userTimeSeconds: number) => boolean
        stopAllMotions?: () => void
      }
    }
    const queue = manager?.queueManager
    if (!manager || !queue || typeof queue.doUpdateMotion !== 'function') return

    this.channelHeldEntries[channel] = new WeakSet<object>()
    this.channelFinishFiredEntries[channel] = new WeakSet<object>()

    const origDoUpdate = queue.doUpdateMotion.bind(queue)
    queue.doUpdateMotion = (model: unknown, userTimeSeconds: number) => {
      const heldEntries = this.channelHeldEntries[channel]
      const finishFired = this.channelFinishFiredEntries[channel]
      const entries = queue._motions
      if (Array.isArray(entries)) {
        this.channelEntryCounts[channel] = entries.length
        for (const entry of entries) {
          if (!entry || entry.isFinished?.() || !entry.isStarted?.()) continue
          const m = entry._motion
          if (!m) continue

          const startTime = entry.getStartTime?.() ?? userTimeSeconds
          // Clock jumped backwards (e.g., VirtualClockController install on a pooled warm page).
          if (startTime > userTimeSeconds + 0.25) {
            entry.setStartTime?.(userTimeSeconds)
            entry.setFadeInStartTime?.(userTimeSeconds)
            entry.setLastCheckEventSeconds?.(userTimeSeconds)
            if ((entry.getEndTime?.() ?? -1) > userTimeSeconds) {
              entry.setEndTime?.(-1)
            }
          }

          const isLoop =
            typeof m.isLoop === 'function'
              ? m.isLoop()
              : Boolean(m._isLoop ?? (m._motionData?.loop && this.oneShotWaitDepth === 0))
          const rawDuration =
            m._motionData?.duration ??
            m._loopDurationSeconds ??
            (typeof m.getDuration === 'function' ? m.getDuration() : 0)
          const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0
          if (isLoop || duration <= 0) continue

          const effectiveStart = entry.getStartTime?.() ?? userTimeSeconds
          const elapsed = userTimeSeconds - effectiveStart
          const clampStart = userTimeSeconds - Math.max(0, duration - 1e-4)

          if (!entry.isTriggeredFadeOut?.()) {
            // Suppress premature auto fadeOut over the last _fadeOutSeconds of short clips.
            entry.setEndTime?.(-1)
            if (elapsed >= duration - 1e-4) {
              heldEntries.add(entry)
              if (!finishFired.has(entry)) {
                finishFired.add(entry)
                try {
                  m._onFinishedMotion?.(m)
                } catch {
                  /* ignore finish handler error */
                }
              }
              entry.setStartTime?.(clampStart)
            }
          } else {
            heldEntries.delete(entry)
            const endTime = entry.getEndTime?.() ?? -1
            if (elapsed >= duration - 1e-4 && (endTime < 0 || userTimeSeconds <= endTime)) {
              entry.setStartTime?.(clampStart)
            }
          }
        }
      }
      const playableResult = this.tryUpdatePlayableBlend(channel, queue, model, userTimeSeconds)
      const result = playableResult !== null ? playableResult : origDoUpdate(model, userTimeSeconds)
      if (Array.isArray(queue._motions)) {
        for (const entry of queue._motions) {
          if (
            !entry ||
            entry.isFinished?.() ||
            !entry.isStarted?.() ||
            entry.isTriggeredFadeOut?.()
          ) {
            continue
          }
          const m = entry._motion
          if (!m) continue
          const isLoop =
            typeof m.isLoop === 'function'
              ? m.isLoop()
              : Boolean(m._isLoop ?? (m._motionData?.loop && this.oneShotWaitDepth === 0))
          const rawDuration =
            m._motionData?.duration ??
            m._loopDurationSeconds ??
            (typeof m.getDuration === 'function' ? m.getDuration() : 0)
          if (!isLoop && Number.isFinite(rawDuration) && rawDuration > 0) {
            entry.setEndTime?.(-1)
          }
        }
        this.channelEntryCounts[channel] = queue._motions.length
      }
      return result
    }

    if (typeof queue.stopAllMotions === 'function') {
      const origStopAll = queue.stopAllMotions.bind(queue)
      queue.stopAllMotions = () => {
        this.channelHeldEntries[channel] = new WeakSet<object>()
        this.channelFinishFiredEntries[channel] = new WeakSet<object>()
        this.channelEntryCounts[channel] = 0
        clearPlayableBlendLayer(this.getPlayableLayer(channel))
        this.getPlayableLayerLastTime()[channel] = null
        origStopAll()
      }
    }

    if (typeof manager.isFinished === 'function') {
      const origIsFinished = manager.isFinished.bind(manager)
      manager.isFinished = () => {
        if (origIsFinished()) return true
        const entries = queue._motions
        if (!Array.isArray(entries) || entries.length === 0) return true
        const currentHeld = this.channelHeldEntries[channel]
        return entries.every((entry) => !entry || entry.isFinished?.() || currentHeld.has(entry))
      }
    }
  }

  private getPlayableLayer(channel: 0 | 1): PlayableBlendLayer<object> {
    if (!this.playableLayers) {
      this.playableLayers = [createPlayableBlendLayer<object>(), createPlayableBlendLayer<object>()]
    }
    return this.playableLayers[channel]
  }

  private getPlayableLayerLastTime(): [number | null, number | null] {
    if (!this.playableLayerLastTime) {
      this.playableLayerLastTime = [null, null]
    }
    return this.playableLayerLastTime
  }

  private getChannelAnimatedParamSet(channel: 0 | 1): Set<number> {
    if (!this.channelAnimatedParamIndices) {
      this.channelAnimatedParamIndices = [new Set<number>(), new Set<number>()]
    }
    return this.channelAnimatedParamIndices[channel]
  }

  /**
   * 官方 `PlayableAnimator` / `PlayableBlender` 逐帧线性归一化混合
   * （移植自 `SekaiStoryExporter/crates/sse-live2d/src/motion.rs:162-258`）。
   *
   * 仅在真实 Cubism4 `coreModel` + `CubismMotion` 上激活；测试替身或 Cubism2 自动返回 null 回退原路径。
   */
  private tryUpdatePlayableBlend(
    channel: 0 | 1,
    queue: {
      _motions?: Array<object | null>
      _eventCallBack?: (caller: unknown, value: string, data: unknown) => void
      _eventCustomData?: unknown
    },
    rawModel: unknown,
    userTimeSeconds: number
  ): boolean | null {
    const core = rawModel as {
      getParameterCount?: () => number
      getParameterIndex?: (id: string) => number
      getParameterValueByIndex?: (index: number) => number
      setParameterValueByIndex?: (index: number, value: number, weight?: number) => void
      getParameterDefaultValue?: (index: number) => number
      getParameterValueById?: (id: string) => number
      setParameterValueById?: (id: string, value: number, weight?: number) => void
      addParameterValueById?: (id: string, value: number, weight?: number) => void
      multiplyParameterValueById?: (id: string, value: number, weight?: number) => void
      setPartOpacityById?: (id: string, value: number) => void
      setPartOpacityByIndex?: (index: number, value: number) => void
      getPartIndex?: (id: string) => number
      setModelOapcity?: (value: number) => void
    } | null
    if (
      !core ||
      typeof core.getParameterCount !== 'function' ||
      typeof core.getParameterIndex !== 'function' ||
      typeof core.getParameterValueByIndex !== 'function' ||
      typeof core.setParameterValueByIndex !== 'function' ||
      typeof core.getParameterDefaultValue !== 'function'
    ) {
      return null
    }
    const entries = queue._motions
    if (!Array.isArray(entries) || entries.length === 0) return null

    const layer = this.getPlayableLayer(channel)
    // 剔除已不在 queue._motions 中的陈旧输入
    const liveSet = new Set(entries.filter((e): e is object => Boolean(e)))
    layer.inputs = layer.inputs.filter((input) => liveSet.has(input.key))
    if (layer.inputs.length === 0) return null

    type MotionEntryLike = {
      _motion?: {
        _fadeInSeconds?: number
        _fadeOutSeconds?: number
        _offsetSeconds?: number
        getDuration?: () => number
        doUpdateParameters?: (
          model: unknown,
          userTimeSeconds: number,
          fadeWeight: number,
          entry: unknown
        ) => void
        getFiredEvent?: (before: number, after: number) => string[]
      }
      isAvailable?: () => boolean
      isStarted?: () => boolean
      setIsStarted?: (started: boolean) => void
      isFinished?: () => boolean
      getStartTime?: () => number
      setStartTime?: (t: number) => void
      setFadeInStartTime?: (t: number) => void
      getEndTime?: () => number
      setEndTime?: (t: number) => void
      getLastCheckEventSeconds?: () => number
      setLastCheckEventSeconds?: (t: number) => void
      setState?: (t: number, weight: number) => void
      release?: () => void
    }

    for (const input of layer.inputs) {
      const entry = input.key as MotionEntryLike
      if (typeof entry._motion?.doUpdateParameters !== 'function') return null
    }

    const lastTimes = this.getPlayableLayerLastTime()
    const prevTime = lastTimes[channel]
    const dt = AnimationManager.isExporting()
      ? 1 / STORY_FPS
      : prevTime !== null && userTimeSeconds >= prevTime
        ? Math.min(0.25, userTimeSeconds - prevTime)
        : 0
    lastTimes[channel] = userTimeSeconds

    const pruned = advancePlayableBlendLayer(layer, dt)
    if (pruned.length > 0) {
      const prunedSet = new Set(pruned)
      const held = this.channelHeldEntries?.[channel]
      for (let i = entries.length - 1; i >= 0; i--) {
        const candidate = entries[i]
        if (candidate && prunedSet.has(candidate)) {
          held?.delete(candidate)
          ;(candidate as MotionEntryLike).release?.()
          entries.splice(i, 1)
        }
      }
    }

    const paramCount = core.getParameterCount()
    const defaultAt = (index: number): number => {
      if (index < 0 || index >= paramCount) return 0
      const def = core.getParameterDefaultValue!(index)
      return typeof def === 'number' && Number.isFinite(def) ? def : 0
    }

    const animatedSet = this.getChannelAnimatedParamSet(channel)
    const evaluatedInputs: EvaluatedBlendInput[] = []
    const partOpacityInputs: Array<{ weight: number; parts: Map<string, number> }> = []
    const newestInput = layer.inputs[layer.inputs.length - 1]

    for (const input of layer.inputs) {
      const entry = input.key as MotionEntryLike
      const motion = entry._motion!
      if (!entry.isStarted?.()) {
        entry.setIsStarted?.(true)
        const offset =
          typeof motion._offsetSeconds === 'number' && Number.isFinite(motion._offsetSeconds)
            ? motion._offsetSeconds
            : 0
        entry.setStartTime?.(userTimeSeconds - offset)
        entry.setFadeInStartTime?.(userTimeSeconds)
        entry.setLastCheckEventSeconds?.(userTimeSeconds)
        entry.setEndTime?.(-1)
      }
      entry.setState?.(userTimeSeconds, input.weight)

      const captured = new Map<number, number>()
      const capturedParts = new Map<string, number>()
      const proxy = {
        getParameterCount: () => paramCount,
        getParameterIndex: (id: string) => core.getParameterIndex!(id),
        getParameterDefaultValue: (index: number) => defaultAt(index),
        getParameterValueByIndex: (index: number) => captured.get(index) ?? defaultAt(index),
        getParameterValueById: (id: string) => {
          const idx = core.getParameterIndex!(id)
          return idx >= 0 ? (captured.get(idx) ?? defaultAt(idx)) : 0
        },
        setParameterValueByIndex: (index: number, value: number, weight = 1) => {
          if (index < 0 || index >= paramCount) return
          const prev = captured.get(index) ?? defaultAt(index)
          captured.set(index, prev + (value - prev) * weight)
        },
        setParameterValueById: (id: string, value: number, weight = 1) => {
          const idx = core.getParameterIndex!(id)
          if (idx < 0 || idx >= paramCount) return
          const prev = captured.get(idx) ?? defaultAt(idx)
          captured.set(idx, prev + (value - prev) * weight)
        },
        addParameterValueById: (id: string, value: number, weight = 1) => {
          const idx = core.getParameterIndex!(id)
          if (idx < 0 || idx >= paramCount) return
          const prev = captured.get(idx) ?? defaultAt(idx)
          captured.set(idx, prev + value * weight)
        },
        multiplyParameterValueById: (id: string, value: number, weight = 1) => {
          const idx = core.getParameterIndex!(id)
          if (idx < 0 || idx >= paramCount) return
          const prev = captured.get(idx) ?? defaultAt(idx)
          captured.set(idx, prev * (1 + (value - 1) * weight))
        },
        setPartOpacityById: (id: string, value: number) => {
          capturedParts.set(id, value)
        },
        setPartOpacityByIndex: (index: number, value: number) => {
          core.setPartOpacityByIndex?.(index, value)
        },
        getPartIndex: (id: string) => core.getPartIndex?.(id) ?? -1,
        setModelOapcity: (value: number) => {
          core.setModelOapcity?.(value)
        }
      }

      const prevFadeIn = motion._fadeInSeconds
      const prevFadeOut = motion._fadeOutSeconds
      const prevEnd = entry.getEndTime?.()
      try {
        motion._fadeInSeconds = 0
        motion._fadeOutSeconds = 0
        entry.setEndTime?.(-1)
        motion.doUpdateParameters!(proxy, userTimeSeconds, 1, entry)
      } finally {
        if (prevFadeIn !== undefined) motion._fadeInSeconds = prevFadeIn
        if (prevFadeOut !== undefined) motion._fadeOutSeconds = prevFadeOut
        if (prevEnd !== undefined) entry.setEndTime?.(prevEnd)
      }

      for (const idx of captured.keys()) {
        animatedSet.add(idx)
      }
      evaluatedInputs.push({ weight: input.weight, values: captured })
      if (capturedParts.size > 0) {
        partOpacityInputs.push({ weight: input.weight, parts: capturedParts })
      }

      // 官方 `Animator::advance`：只在最新输入上派发 `UserData` 事件（如 eyeblink）
      if (input === newestInput && typeof motion.getFiredEvent === 'function') {
        const startTime = entry.getStartTime?.() ?? userTimeSeconds
        const lastCheck = entry.getLastCheckEventSeconds?.() ?? userTimeSeconds
        const fired = motion.getFiredEvent(lastCheck - startTime, userTimeSeconds - startTime)
        if (Array.isArray(fired) && typeof queue._eventCallBack === 'function') {
          for (const eventValue of fired) {
            queue._eventCallBack(queue, eventValue, queue._eventCustomData)
          }
        }
        entry.setLastCheckEventSeconds?.(userTimeSeconds)
      }
    }

    const blended = evaluateBlendedLayerValues(evaluatedInputs, defaultAt)
    if (channel === 0) {
      // 身体层本帧不再覆盖的旧参数回归默认值（避免切动作后残留旧手臂/躯干值）
      for (const idx of animatedSet) {
        if (!blended.has(idx)) {
          core.setParameterValueByIndex(idx, defaultAt(idx), 1)
        }
      }
      this.lastBodyEvaluatedIndices = new Set(blended.keys())
    } else {
      // 表情层不再覆盖的旧表情参数回归默认值（若身体层本帧未驱动该参数）
      const bodySet = this.lastBodyEvaluatedIndices
      for (const idx of animatedSet) {
        if (!blended.has(idx) && !bodySet?.has(idx)) {
          core.setParameterValueByIndex(idx, defaultAt(idx), 1)
        }
      }
    }

    for (const [idx, value] of blended.entries()) {
      core.setParameterValueByIndex(idx, value, 1)
    }

    if (partOpacityInputs.length > 0 && typeof core.setPartOpacityById === 'function') {
      const partIds = new Set<string>()
      for (const item of partOpacityInputs) {
        for (const id of item.parts.keys()) partIds.add(id)
      }
      for (const id of partIds) {
        let acc = 0
        for (const item of partOpacityInputs) {
          acc += item.weight * (item.parts.get(id) ?? 1)
        }
        core.setPartOpacityById(id, acc)
      }
    }

    return true
  }

  /**
   * 离台模型不累积 deltaTime：串行 TTS 预热或 LayoutClear 退场期间 Ticker.shared 仍在推进，
   * 离台期间 _render 不执行，若让 deltaTime 持续累加到数十秒，重新入场首帧会把几十秒的 dt
   * 一次性灌进 Cubism 物理与姿势，造成剧烈抖动与首帧卡顿。
   */
  public override update(dt: number): void {
    if (this.destroyed) return
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0
    if (!this.parent) {
      this.deltaTime = 0
      this.elapsedTime += Math.min(safeDt, 250)
      return
    }
    const maxStep = AnimationManager.isExporting() ? 250 : 100
    super.update(Math.min(safeDt, maxStep))
  }

  public resetClockBaselines(now = performance.now()): void {
    this.lastNaturalUpdateMs = now
    this.currentBodyStartedAt = now
    this.deltaTime = 0
    // 同一 worker 连续导出时，眨眼/呼吸相位必须回到按模型 id 派生的确定性起点：
    // 同一 id 每次导出一致，不同角色彼此独立，不再全体同步眨眼/呼吸。
    const seed = naturalMotionSeed(this._metadata?.id ?? 1)
    this.blinkState = createBlinkState(seed)
    this.breathDegree = createBreathDegree(seed)
    this.getPlayableLayerLastTime()[0] = null
    this.getPlayableLayerLastTime()[1] = null
    if (this.lastChangeBlinkTime !== null) {
      this.lastChangeBlinkTime = now
    }
    // Cubism4InternalModel.update(dt, now) 传给 queueManager 的时间轴是 this.elapsedTime / 1000，
    // 不能用 performance.now() / 1000 覆盖，否则虚拟时钟归零时会把正在播放的动作基准拉偏。
    const clockMs =
      typeof this.elapsedTime === 'number' &&
      Number.isFinite(this.elapsedTime) &&
      this.elapsedTime > 0
        ? this.elapsedTime
        : now
    const nowSeconds = clockMs / 1000
    for (const channel of [0, 1] as const) {
      const entries = (
        this.internalModel?.parallelMotionManager?.[channel] as unknown as {
          queueManager?: {
            _motions?: Array<{
              getStartTime?: () => number
              setStartTime?: (t: number) => void
              setFadeInStartTime?: (t: number) => void
              setEndTime?: (t: number) => void
              setLastCheckEventSeconds?: (t: number) => void
              isTriggeredFadeOut?: () => boolean
            } | null>
          }
        }
      )?.queueManager?._motions
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (!entry) continue
        const prevStart = entry.getStartTime?.()
        if (prevStart === undefined || prevStart > nowSeconds) {
          entry.setStartTime?.(nowSeconds)
          entry.setFadeInStartTime?.(nowSeconds)
          entry.setLastCheckEventSeconds?.(nowSeconds)
          if (!entry.isTriggeredFadeOut?.()) {
            entry.setEndTime?.(-1)
          }
        }
      }
    }
  }

  /**
   * Wrap loadMotion so every loaded clip gets its curve ids normalized to the
   * model's actual parameter ids. Runs once per cached motion object (loadMotion
   * memoizes), before the clip is ever started.
   */
  private installMotionIdNormalization(): void {
    const internal = this.internalModel
    const motionManager = internal?.motionManager
    if (!motionManager || typeof motionManager.loadMotion !== 'function') return
    const core = internal.coreModel as unknown as {
      _parameterIds?: string[]
      parameters?: { ids?: string[] }
    }
    const modelIds =
      internal instanceof Cubism4InternalModel
        ? (core?._parameterIds ?? core?.parameters?.ids)
        : undefined
    const idSet = modelIds?.length ? new Set(modelIds) : null
    const originalLoad = motionManager.loadMotion.bind(motionManager)
    motionManager.loadMotion = (group: string, index: number) =>
      Promise.resolve(originalLoad(group, index)).then((motion) => {
        if (motion) {
          if (idSet) this.normalizeMotionParameterIds(motion, idSet)
          if (group.startsWith('face_')) this.collectFacialCurveIds(motion)
        }
        return motion
      })
  }

  private extractMotionCurveIds(motion: unknown): string[] {
    const typed = motion as {
      _motionData?: { curves?: Array<{ id?: string }> }
      motions?: Array<{ _$4P?: string }>
    } | null
    if (!typed) return []
    const ids: string[] = []
    if (Array.isArray(typed._motionData?.curves)) {
      for (const curve of typed._motionData.curves) {
        if (curve?.id) ids.push(curve.id)
      }
    } else if (Array.isArray(typed.motions)) {
      for (const item of typed.motions) {
        if (item?._$4P) ids.push(item._$4P)
      }
    }
    return ids
  }

  private getFacialManagedParamSet(): Set<string> {
    return (this.facialManagedParamIds ??= new Set<string>())
  }

  private getDefaultParamValueMap(): Map<string, number> {
    return (this.defaultParamValues ??= new Map<string, number>())
  }

  private collectFacialCurveIds(motion: unknown): void {
    const managed = this.getFacialManagedParamSet()
    for (const id of this.extractMotionCurveIds(motion)) {
      if (this.modelParamIds && !this.modelParamIds.has(id)) continue
      managed.add(id)
    }
  }

  private collectPreloadedFacialParams(): void {
    const groups = this.internalModel?.motionManager?.motionGroups as
      | Record<string, unknown[]>
      | undefined
    if (!groups) return
    for (const [name, list] of Object.entries(groups)) {
      if (!name.startsWith('face_') || !Array.isArray(list)) continue
      for (const motion of list) {
        if (motion) this.collectFacialCurveIds(motion)
      }
    }
  }

  private seedDefaultParameterValues(): void {
    const defaults = this.getDefaultParamValueMap()
    const core = this.internalModel?.coreModel as unknown as {
      _parameterIds?: string[]
      parameters?: { ids?: string[] }
      getParameterIndex?: (id: string) => number
      getParameterDefaultValue?: (index: number) => number
      getParameterValueById?: (id: string) => number
      getParamFloat?: (id: string) => number
    }
    if (!core) return
    const ids = core._parameterIds ?? core.parameters?.ids ?? []
    for (const id of ids) {
      const index = core.getParameterIndex?.(id) ?? -1
      const def =
        index >= 0 && typeof core.getParameterDefaultValue === 'function'
          ? core.getParameterDefaultValue(index)
          : typeof core.getParameterValueById === 'function'
            ? core.getParameterValueById(id)
            : core.getParamFloat?.(id)
      if (typeof def === 'number' && Number.isFinite(def)) {
        defaults.set(id, def)
      }
    }
  }

  private getParameterDefaultValueById(id: string): number {
    const defaults = this.getDefaultParamValueMap()
    const cached = defaults.get(id)
    if (cached !== undefined) return cached
    const core = this.internalModel?.coreModel as unknown as {
      getParameterIndex?: (paramId: string) => number
      getParameterDefaultValue?: (index: number) => number
    }
    const index = core?.getParameterIndex?.(id) ?? -1
    const def =
      index >= 0 && typeof core?.getParameterDefaultValue === 'function'
        ? core.getParameterDefaultValue(index)
        : 0
    const resolved = typeof def === 'number' && Number.isFinite(def) ? def : 0
    defaults.set(id, resolved)
    return resolved
  }

  private setCoreParameterValue(coreTarget: unknown, id: string, value: number): void {
    const core = (coreTarget ?? this.internalModel?.coreModel) as {
      setParameterValueById?: (paramId: string, val: number) => void
      setParamFloat?: (paramId: string, val: number) => void
    } | null
    if (!core) return
    if (typeof core.setParameterValueById === 'function') {
      core.setParameterValueById(id, value)
    } else if (typeof core.setParamFloat === 'function') {
      core.setParamFloat(id, value)
    }
  }

  private installFacialDefaultReset(): void {
    const manager = this.internalModel?.parallelMotionManager?.[1] as unknown as {
      update?: (core: unknown, now: number) => boolean
      queueManager?: {
        _motions?: Array<{ isFinished?: () => boolean; _motion?: unknown } | null>
      }
    }
    if (!manager || typeof manager.update !== 'function') return
    const originalUpdate = manager.update
    manager.update = (core, now): boolean => {
      const entries = manager.queueManager?._motions
      if (Array.isArray(entries) && entries.length > 0) {
        let newestMotion: unknown = null
        for (const entry of entries) {
          if (!entry) continue
          this.collectFacialCurveIds(entry._motion)
          if (!entry.isFinished?.()) {
            newestMotion = entry._motion
          }
        }
        const managed = this.getFacialManagedParamSet()
        if (newestMotion && managed.size > 0) {
          const newestCurves = new Set(this.extractMotionCurveIds(newestMotion))
          for (const id of managed) {
            if (newestCurves.has(id)) continue
            if (this.modelParamIds && !this.modelParamIds.has(id)) continue
            this.setCoreParameterValue(core, id, this.getParameterDefaultValueById(id))
          }
        }
      }
      return originalUpdate.call(manager, core, now)
    }
    this.restoreFacialUpdate = () => {
      manager.update = originalUpdate
    }
  }

  private normalizeMotionParameterIds(motion: unknown, modelIds: Set<string>): void {
    const data = (motion as { _motionData?: { curves?: Array<{ id: string }> } })._motionData
    if (!data?.curves) return
    for (const curve of data.curves) {
      const id = curve.id
      if (!id || modelIds.has(id)) continue
      for (const candidate of MOTION_PARAMETER_ID_ALIASES.get(id) ?? []) {
        if (modelIds.has(candidate)) {
          curve.id = candidate
          break
        }
      }
    }
  }

  /**
   * The dependency implements ignoreParamIds by deleting cached motion curves.
   * Preserve parameters around body updates instead, leaving every clip reusable.
   */
  private installBodyParameterIsolation(): void {
    const manager = this.internalModel.parallelMotionManager[0]
    const originalUpdate = manager.update
    manager.update = (core, now): boolean => {
      const internal = this.internalModel
      const ignoredIds = this.getEffectiveBodyIgnoredParamIds()
      const values = ignoredIds.map((id) => ({
        id,
        value:
          internal instanceof Cubism4InternalModel
            ? internal.coreModel.getParameterValueById(id)
            : internal instanceof Cubism2InternalModel
              ? internal.coreModel.getParamFloat(id)
              : 0
      }))
      let updated: boolean
      try {
        updated = originalUpdate.call(manager, core, now)
      } finally {
        for (const { id, value } of values) {
          if (internal instanceof Cubism4InternalModel) {
            internal.coreModel.setParameterValueById(id, value)
          } else if (internal instanceof Cubism2InternalModel) {
            internal.coreModel.setParamFloat(id, value)
          }
        }
      }
      this.maybeStartBodyChain()
      return updated
    }
    this.restoreBodyUpdate = () => {
      manager.update = originalUpdate
    }
  }

  /**
   * body 通道空闲后的接续（idleChainGapMs 控制）：
   * - 0：保持动作结束姿势（不回落站立），不再接续——剧本 cue 之间的自然停顿
   * - >0：等待间隔（±25% 抖动）后再接一个同情绪族手势；期间来新 cue 会推进代数，定时器自然失效
   * 代数检查保证任何路径都不会覆盖新 cue；legacy 的 waitForMotionsFinished
   * 路径通过 applyMotion 的 disarm 保持"等播完"的原语义。
   */
  private maybeStartBodyChain(): void {
    const internal = this.internalModel
    const manager = internal?.parallelMotionManager[0]
    if (!internal || !manager || this.destroyed) return
    if (
      !manager.playing &&
      manager.isFinished() &&
      this.currentBodyMotion &&
      !this.bodyFinishReported
    ) {
      this.bodyFinishReported = true
      // `OnFinishMotion`：只有非循环 clip 越过结尾才唤醒自动眨眼。
      bodyMotionFinishedBlink(
        this.blinkState,
        this.currentBodyMotion ? this.isMotionLooping(this.currentBodyMotion) : true
      )
      const now = performance.now()
      if (now < this.currentBodyStartedAt) this.currentBodyStartedAt = now
      motionTrace.record({
        at: now,
        modelId: this.metadata.id,
        snippetIndex: this.currentBodySnippetIndex,
        channel: 0,
        name: this.currentBodyMotion,
        event: 'finished',
        playedMs: Math.max(0, now - this.currentBodyStartedAt),
        clipDurationMs: this.currentBodyClipDurationMs
      })
    }
    // 非循环身体动作播完后 Controller.WakeUp()；循环 clip 每圈结束不唤醒。
    if (!manager.playing && manager.isFinished() && this.currentBodyMotion) {
      bodyMotionFinishedBlink(this.blinkState, this.isMotionLooping(this.currentBodyMotion))
    }
    if (!this.bodyChainArmed) return
    if (!manager.isFinished() || manager.playing) return
    this.bodyChainArmed = false
    if (this.bodyChainGeneration !== this.channelGeneration[0]) return
    const alpha = this.getCurrentOpacity()
    if (alpha <= 0.01) return
    const gapMs = AdvancedModel.idleChainGapMs
    if (gapMs > 0) {
      if (this.bodyChainTimer) clearTimeout(this.bodyChainTimer)
      this.bodyChainTimer = setTimeout(
        () => {
          this.bodyChainTimer = null
          if (this.destroyed) return
          const mgr = this.internalModel?.parallelMotionManager[0]
          if (!mgr || this.bodyChainGeneration !== this.channelGeneration[0]) return
          if (!mgr.isFinished() || mgr.playing) return
          const next = this.pickChainMotion()
          if (!next) return
          void this.startCharacterChannel(
            0,
            next,
            [],
            undefined,
            undefined,
            true,
            this.currentBodySnippetIndex
          )
        },
        gapMs * (0.75 + Math.random() * 0.5)
      )
    }
    // gap=0：不回落站立，保持动作结束时的姿势，直到下一个 cue 或退场接管
  }

  private listBodyMotionDefinitions(): string[] {
    const definitions = this.internalModel?.motionManager?.definitions as
      | Record<string, unknown>
      | undefined
    return Object.keys(definitions ?? {}).filter((name) => !name.startsWith('face_'))
  }

  private pickChainMotion(): string | null {
    const allRaw = this.listBodyMotionDefinitions()
    if (!allRaw.length) return this.defaultMotionName
    const nonStanding = allRaw.filter((name) => !MODEL_PREFIX_STANDING_RE.test(name))
    const all = nonStanding.length ? nonStanding : allRaw
    const last = this.recentBodyMotions[this.recentBodyMotions.length - 1]
    const family = last ? motionFamilyKey(last) : null
    let pool = family ? all.filter((name) => motionFamilyKey(name) === family) : []
    if (pool.length <= 1) pool = all
    const recent = new Set(this.recentBodyMotions.slice(-2))
    const fresh = pool.filter((name) => !recent.has(name))
    const source = fresh.length ? fresh : pool
    return source[Math.floor(Math.random() * source.length)] ?? this.defaultMotionName
  }

  private pickEntryMotion(seedOffset = 0): string | null {
    const allRaw = this.listBodyMotionDefinitions()
    if (!allRaw.length) return this.defaultMotionName
    const nonStanding = allRaw.filter((name) => !MODEL_PREFIX_STANDING_RE.test(name))
    const basePool = nonStanding.length ? nonStanding : allRaw
    const normalFamily = basePool.filter((name) => motionFamilyKey(name) === 'w-normal')
    const pool = normalFamily.length >= 2 ? normalFamily : basePool
    const recent = new Set(this.recentBodyMotions.slice(-2))
    const fresh = pool.filter((name) => !recent.has(name) && name !== this.currentBodyMotion)
    const source = (fresh.length ? fresh : pool).slice().sort()
    const modelSalt = Math.abs(this._metadata?.id ?? 0) * 3 + Math.max(0, seedOffset)
    return source[modelSalt % source.length] ?? this.defaultMotionName
  }

  /** 入场动作播完后调用：body 通道进入连续表演，台词间隙不再站桩。 */
  public startBodyIdleLoop(): void {
    this.bodyChainGeneration = this.channelGeneration[0]
    this.bodyChainArmed = true
  }

  /** 剧本给的动作可能来自别的模型/旧资源；不存在的动作会加载失败，必须能提前判断。 */
  public hasMotion(name: string): boolean {
    if (!name) return false
    const groups = this.internalModel?.motionManager?.motionGroups as
      | Record<string, unknown>
      | undefined
    return Boolean(groups && groups[name])
  }

  private loadedMotion(name: string): unknown {
    const groups = this.internalModel?.motionManager?.motionGroups as
      | Record<string, unknown[]>
      | undefined
    return groups?.[name]?.[0] ?? null
  }

  /** 已预加载动作的剪辑时长；循环动作返回 0（官方自动模式等不到它结束）。 */
  public getMotionDurationMs(name: string): number {
    const motion = this.loadedMotion(name)
    if (!motion || this.isMotionLooping(name)) return 0
    return this.motionClipDurationMs(motion)
  }

  public isMotionLooping(name: string): boolean {
    const motion = this.loadedMotion(name) as {
      isLoop?: () => boolean
      _isLoop?: boolean
    } | null
    if (!motion) return false
    if (typeof motion.isLoop === 'function') {
      return Boolean(motion.isLoop())
    }
    if (typeof motion._isLoop === 'boolean') {
      return motion._isLoop
    }
    return false
  }

  /**
   * 入场兜底动作：剧本没给 motion/facial 时也不能站桩淡入。
   * 按模型 id 与片段索引轮换同款非站立待机姿态，避免多人齐刷刷复读同一姿势，
   * 并隔离面部与眼球参数，防止覆盖表情或自然眨眼。
   */
  public async startEntryMotion(
    applyDefaultFacial = true,
    traceSnippetIndex?: number
  ): Promise<void> {
    if (applyDefaultFacial && this.defaultFacialName) {
      await this.applyFacial(this.defaultFacialName, true, traceSnippetIndex)
    }
    const motion = this.pickEntryMotion(traceSnippetIndex ?? 0)
    // 只启动已预加载的动作。兜底动作不在剧本 cue 里，StoryManager 不会预载；
    // 对缺失/未缓存的动作调用 loadMotion 会卡住整次导出（最小剧本空 motion 实测）。
    if (motion && this.hasMotion(motion)) {
      await this.applyMotion(
        motion,
        true,
        this.facialIsolationParamIds({
          includeEyeOpen: false,
          includeMouthOpen: true,
          includeNonEyeOpenFacial: true
        }),
        traceSnippetIndex
      )
    }
  }

  private eyeParameterIds(): string[] {
    return this.internalModel instanceof Cubism2InternalModel
      ? [
          'PARAM_EYE_R_OPEN',
          'PARAM_EYE_L_OPEN',
          'PARAM_EYE_BALL_X',
          'PARAM_EYE_BALL_Y',
          'PARAM_EYEBALL_X',
          'PARAM_EYEBALL_Y'
        ]
      : [
          'ParamEyeROpen',
          'ParamEyeLOpen',
          'ParamEyeballX',
          'ParamEyeballY',
          'ParamEyeBallX',
          'ParamEyeBallY'
        ]
  }

  private filterToExistingModelParams(ids: readonly string[]): string[] {
    const paramSet = this.modelParamIds
    if (!paramSet) return [...ids]
    return ids.filter((id) => paramSet.has(id))
  }

  private hasChannel1FacialActive(): boolean {
    if (this.currentFacialName) return true
    const mgr = this.internalModel?.parallelMotionManager?.[1] as unknown as {
      playing?: boolean
      queueManager?: { _motions?: unknown[] }
    }
    if (!mgr) return false
    if (Array.isArray(mgr.queueManager?._motions) && mgr.queueManager._motions.length > 0) {
      return true
    }
    return Boolean(mgr.playing)
  }

  private hasActiveHeldEntry(channel: 0 | 1): boolean {
    const mgr = this.internalModel?.parallelMotionManager?.[channel] as unknown as {
      queueManager?: { _motions?: Array<object | null> }
    }
    const entries = mgr?.queueManager?._motions
    if (!Array.isArray(entries) || entries.length === 0) return false
    const held = this.channelHeldEntries?.[channel]
    return Boolean(held && entries.some((e) => Boolean(e && held.has(e))))
  }

  private facialIsolationParamIds(opts: {
    includeEyeOpen: boolean
    includeMouthOpen: boolean
    includeNonEyeOpenFacial: boolean
  }): string[] {
    const out: string[] = []
    const isC2 = this.internalModel instanceof Cubism2InternalModel
    if (opts.includeEyeOpen) {
      out.push(...this.eyeParameterIds().slice(0, 2))
    }
    if (opts.includeEyeOpen || opts.includeNonEyeOpenFacial) {
      // Eyeballs stay after [0, 1] inside eyeParameterIds().
      out.push(...this.eyeParameterIds().slice(2))
    }
    if (opts.includeMouthOpen) {
      out.push(isC2 ? 'PARAM_MOUTH_OPEN_Y' : 'ParamMouthOpenY')
    }
    if (opts.includeNonEyeOpenFacial) {
      out.push(
        ...(isC2
          ? [
              'PARAM_BROW_L_X',
              'PARAM_BROW_L_Y',
              'PARAM_BROW_R_X',
              'PARAM_BROW_R_Y',
              'PARAM_BROW_L_ANGLE',
              'PARAM_BROW_R_ANGLE',
              'PARAM_BROW_L_FORM',
              'PARAM_BROW_R_FORM',
              'PARAM_EYE_L_SMILE',
              'PARAM_EYE_R_SMILE',
              'PARAM_MOUTH_FORM',
              'PARAM_CHEEK',
              'PARAM_TEAR',
              'PARAM_SWEAT',
              'PARAM_BREATH'
            ]
          : [
              'ParamBrowLX',
              'ParamBrowLY',
              'ParamBrowRX',
              'ParamBrowRY',
              'ParamBrowLAngle',
              'ParamBrowRAngle',
              'ParamBrowLForm',
              'ParamBrowRForm',
              'ParamBrowForm01',
              'ParamBrowForm02',
              'ParamBrowWrinkleL',
              'ParamBrowWrinkleR',
              'ParamBrowLWrinkle',
              'ParamBrowRWrinkle',
              'ParamEyeLSmile',
              'ParamEyeRSmile',
              'ParamEyeLForm',
              'ParamEyeRForm',
              'ParamEyeSize',
              'ParamEyeTeary',
              'ParamEyeChange',
              'ParamEyeSpecial',
              'ParamEye_kira',
              'ParamKirakira',
              'ParamSpecialEye01',
              'ParamSpecialEye02',
              'ParamSpecialEye03',
              'ParamSpecialEyeRotate1',
              'ParamHighlight',
              'ParamHighlightL',
              'ParamHighlightR',
              'ParamEyeHighlight',
              'ParamEyeHiLight',
              'ParamDarkcycles',
              'ParamEyelids',
              'ParamReflectedLight',
              'ParamMouthForm',
              'ParamMouthForm2',
              'ParamMouthForm01',
              'ParamMouthForm02',
              'ParamMouthPositionY',
              'ParamMouthScaleX',
              'ParamMouthScaleY',
              'ParamCheek',
              'ParamCheek2',
              'ParamCheekAngry',
              'ParamCheekAngry01',
              'ParamCheekAngry02',
              'ParamTear',
              'ParamTear01',
              'ParamTear02',
              'ParamCry',
              'ParamSweat',
              'ParamSweat01',
              'ParamSweat02',
              'ParamFaceShadow',
              'ParamFaceShadow2',
              'ParamTeeth',
              'ParamTeeth2',
              'ParamBreath'
            ])
      )
      if (this.modelParamIds) {
        for (const id of this.modelParamIds) {
          if (NON_EYE_OPEN_FACIAL_PARAM_RE.test(id)) out.push(id)
        }
      }
    }
    return [...new Set(this.filterToExistingModelParams(out))]
  }

  private getEffectiveBodyIgnoredParamIds(): string[] {
    const base = this.bodyIgnoredParamIds ?? []
    const baseSet = new Set(base)
    const eyeOpenSet = new Set(this.eyeParameterIds().slice(0, 2))
    let extra: string[] | null = null
    const appendIgnored = (id: string | undefined): void => {
      if (!id || baseSet.has(id)) return
      if (this.bodyAllowEyeOverride && eyeOpenSet.has(id)) return
      if (this.modelParamIds && !this.modelParamIds.has(id)) return
      baseSet.add(id)
      if (!extra) extra = [...base]
      extra.push(id)
    }
    for (const id of this.getFacialManagedParamSet()) {
      appendIgnored(id)
    }
    if (this.currentFacialName) {
      const motion = this.loadedMotion(this.currentFacialName)
      for (const id of this.extractMotionCurveIds(motion)) {
        appendIgnored(id)
      }
    }
    return extra ?? base
  }

  private async startCharacterChannel(
    channel: 0 | 1,
    name: string,
    ignoredParamIds: string[] = [],
    signal?: AbortSignal,
    canApply?: () => boolean,
    chainAfter = false,
    traceSnippetIndex?: number,
    channelOptions?: { bodyForce?: boolean; facialForce?: boolean }
  ): Promise<void> {
    const generation = ++this.channelGeneration[channel]
    if (channel === 0) {
      // legacy 入场/退场/标量 Motion 播完需要"等播完"的原语义，必须解除续演武装；
      // 只有动作 cue 与续演（chainAfter=true）才会在播完后接着演下一个。
      this.bodyChainArmed = chainAfter
      if (chainAfter) {
        this.bodyChainGeneration = generation
      }
    }
    const internal = this.internalModel
    const requestedAt = performance.now()
    if (channel === 0 || channel === 1) {
      motionTrace.record({
        at: requestedAt,
        modelId: this.metadata.id,
        snippetIndex: traceSnippetIndex,
        channel,
        name,
        event: 'request'
      })
    }
    if (!internal || this.destroyed || signal?.aborted || this.actionSignal.aborted) {
      motionTrace.record({
        at: performance.now(),
        modelId: this.metadata.id,
        snippetIndex: traceSnippetIndex,
        channel,
        name,
        event: 'skipped',
        reason: 'model destroyed or action aborted'
      })
      return
    }
    const manager = internal.parallelMotionManager[channel]
    // 同一个表情或身体动作已经在播时，官方 PlayableAnimator 不会产生可见变化；
    // 重新 startMotion 还会触发误报 interrupted 或与 MotionState 的 reservation 打架。直接视为已应用。
    const isSameActiveCue =
      channel === 1 ? name === this.currentFacialName : name === this.currentBodyMotion
    const channelIsActivelyVisible =
      (manager.playing && !manager.isFinished()) || (channel === 1 && this.hasActiveHeldEntry(1))
    if (isSameActiveCue && channelIsActivelyVisible) {
      if (this.oneShotWaitDepth > 0) {
        this.syncMotionLoopFlag(this.loadedMotion(name))
      }
      motionTrace.record({
        at: requestedAt,
        modelId: this.metadata.id,
        snippetIndex: traceSnippetIndex,
        channel,
        name,
        event: 'skipped',
        reason: channel === 1 ? 'same facial already active' : 'same body motion already active'
      })
      return
    }
    // Invalidate older asynchronous reservations without stopping the currently playing clip.
    manager.state.setReserved(undefined, undefined, 0)
    const motion = await internal.motionManager.loadMotion(name, 0)
    if (motion) {
      this.syncMotionLoopFlag(motion)
      if (channel === 1) this.collectFacialCurveIds(motion)
    }
    const loadedAt = performance.now()
    if (
      !motion ||
      this.destroyed ||
      this.actionSignal.aborted ||
      signal?.aborted ||
      generation !== this.channelGeneration[channel] ||
      (canApply && !canApply())
    ) {
      motionTrace.record({
        at: loadedAt,
        modelId: this.metadata.id,
        snippetIndex: traceSnippetIndex,
        channel,
        name,
        event: 'skipped',
        loadMs: Math.max(0, loadedAt - requestedAt),
        reason: !motion
          ? 'motion not found'
          : generation !== this.channelGeneration[channel]
            ? 'superseded by a newer cue'
            : 'aborted or target hidden'
      })
      if (channel === 0 && !motion && !this.destroyed) {
        // 模型没有这个身体动作：官方先 OnFinishMotion、再 Sleep()，之后不会再唤醒。
        missingBodyMotionBlink(
          this.blinkState,
          this.currentBodyMotion ? this.isMotionLooping(this.currentBodyMotion) : false
        )
      }
      return
    }
    const clipDurationMs = this.motionClipDurationMs(motion)
    motionTrace.record({
      at: loadedAt,
      modelId: this.metadata.id,
      snippetIndex: traceSnippetIndex,
      channel,
      name,
      event: 'loaded',
      loadMs: Math.max(0, loadedAt - requestedAt),
      clipDurationMs
    })
    if (channel === 0) {
      this.bodyIgnoredParamIds = [...ignoredParamIds]
      const eyeOpenIds = this.eyeParameterIds().slice(0, 2)
      const ignoresEyeOpen = eyeOpenIds.some((id) => ignoredParamIds.includes(id))
      this.bodyAllowEyeOverride = !ignoresEyeOpen
      if (
        this.currentBodyMotion &&
        this.currentBodyMotion !== name &&
        manager.playing &&
        !manager.isFinished()
      ) {
        if (loadedAt < this.currentBodyStartedAt) this.currentBodyStartedAt = loadedAt
        motionTrace.record({
          at: loadedAt,
          modelId: this.metadata.id,
          snippetIndex: traceSnippetIndex,
          channel: 0,
          name: this.currentBodyMotion,
          event: 'interrupted',
          playedMs: Math.max(0, loadedAt - this.currentBodyStartedAt),
          clipDurationMs: this.currentBodyClipDurationMs,
          previous: name
        })
      }
      // 官方 `ChangeMotionCore` 结尾无条件 `Sleep()`：任何身体动作切换都停住自动眨眼，
      // 只有非循环 clip 越过结尾时 `OnFinishMotion` 才 `WakeUp()`。
      bodyMotionChangedBlink(this.blinkState)
    }
    // 官方 PlayableAnimator 是交叉淡化，不是先 stopAll 清空旧姿势。
    // 分支顺序与 `ScenarioModel.ChangeMotionCore` 一致：
    // body force&&first → 0、same_category → 0.125、force → 0、否则 clip FadeInTime/0.5；
    // facial force → 0、否则 clip FadeInTime（缺省 0.25）。
    const clipFadeIn = this.clipFadeInSeconds(name)
    const bodyForce = channelOptions?.bodyForce ?? this.firstBodyCue
    const facialForce = channelOptions?.facialForce ?? this.facialForceNext
    const fadeSeconds =
      channel === 0
        ? bodyBlendSeconds(this.currentBodyMotion, name, {
            force: bodyForce,
            first: this.firstBodyCue || !this.currentBodyMotion,
            clipFadeIn
          })
        : facialBlendSeconds(facialForce, clipFadeIn)
    this.channelFadeSeconds[channel] = fadeSeconds
    // 官方 `PlayableAnimator.ChangeAnimation(..., rewind: true)` 对已播完定格的同名身体动作
    // 仍会以 0.125s 重播；pixi `MotionState.reserve` 会因 currentGroup === name 拒绝，
    // 这里在已通过活跃去重检查后清空 currentGroup/Index，让同名身体动作可以重播。
    if (channel === 0) {
      const motionState = manager.state as unknown as {
        currentGroup?: string
        currentIndex?: number
        currentPriority?: number
      }
      if (motionState && motionState.currentGroup === name && motionState.currentIndex === 0) {
        motionState.currentGroup = undefined
        motionState.currentIndex = undefined
        motionState.currentPriority = 0
      }
    }
    const invalidateReservation = (): void => {
      if (generation === this.channelGeneration[channel] && !this.destroyed) {
        manager.state.setReserved(undefined, undefined, 0)
      }
    }
    signal?.addEventListener('abort', invalidateReservation, { once: true })
    try {
      const started = await manager.startMotion(name, 0, MotionPriority.FORCE)
      const startedAt = performance.now()
      motionTrace.record({
        at: startedAt,
        modelId: this.metadata.id,
        snippetIndex: traceSnippetIndex,
        channel,
        name,
        event: started ? 'started' : 'skipped',
        loadMs: Math.max(0, startedAt - requestedAt),
        clipDurationMs,
        fadeMs: Math.round(fadeSeconds * 1000),
        // 同一个表情或动作已经播完但仍是 current group/index 时，manager 也会拒绝
        // 重新 startMotion；视觉上没有变化，不应算成“拒绝”。
        reason: started
          ? undefined
          : channel === 1 && name === this.currentFacialName
            ? 'same facial already active'
            : channel === 0 && name === this.currentBodyMotion
              ? 'same body motion already active'
              : 'motion manager refused the cue'
      })
      if (started && channel === 0) {
        this.currentBodyMotion = name
        this.currentBodySnippetIndex = traceSnippetIndex ?? -1
        this.currentBodyStartedAt = startedAt
        this.currentBodyClipDurationMs = clipDurationMs
        this.bodyFinishReported = false
        this.firstBodyCue = false
        if (name !== this.defaultMotionName && this.recentBodyMotions.at(-1) !== name) {
          this.recentBodyMotions.push(name)
          if (this.recentBodyMotions.length > 6) this.recentBodyMotions.shift()
        }
      }
      if (started && channel === 1) {
        if (channelOptions?.facialForce === undefined) {
          this.facialForceNext = false
        }
        this.currentFacialName = name
      }
    } finally {
      signal?.removeEventListener('abort', invalidateReservation)
    }
  }

  /** 动作的 clip FadeInTime（model3 的 `FileReferences.Motions[name][0].FadeInTime`）。 */
  private clipFadeInSeconds(name: string): number | undefined {
    const definitions = (
      this.internalModel?.motionManager as unknown as {
        definitions?: Record<string, Array<{ FadeInTime?: number }>>
      }
    )?.definitions
    const fade = definitions?.[name]?.[0]?.FadeInTime
    return typeof fade === 'number' && Number.isFinite(fade) ? fade : undefined
  }

  private motionClipDurationMs(motion: unknown): number {
    const getDuration = (motion as { getDuration?: () => number }).getDuration
    if (typeof getDuration === 'function') {
      try {
        const seconds = getDuration.call(motion)
        if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
      } catch {
        /* fall through to motion data */
      }
    }
    const data = (motion as { _motionData?: { duration?: number } })._motionData
    if (data && Number.isFinite(data.duration) && (data.duration ?? 0) > 0) {
      return Math.round((data.duration as number) * 1000)
    }
    return 0
  }

  public async applyMotion(
    motion: string,
    ignoreParams: boolean = false,
    extraIgnoreParamIds: string[] = [],
    traceSnippetIndex?: number,
    options?: { bodyForce?: boolean }
  ): Promise<void> {
    const ignored = [
      ...new Set([...(ignoreParams ? this.eyeParameterIds() : []), ...extraIgnoreParamIds])
    ]
    await this.startCharacterChannel(
      0,
      motion,
      ignored,
      undefined,
      undefined,
      false,
      traceSnippetIndex,
      options?.bodyForce !== undefined ? { bodyForce: options.bodyForce } : undefined
    )
  }

  public async applyFacial(
    facial: string,
    force = false,
    traceSnippetIndex?: number
  ): Promise<void> {
    await this.startCharacterChannel(
      1,
      facial,
      [],
      undefined,
      undefined,
      false,
      traceSnippetIndex,
      { facialForce: force }
    )
  }

  /**
   * Returns remaining ms before an active non-looping body motion reaches 50% playback.
   * Returns 0 if idle, looping, or already >= 50%.
   */
  public getEarlyBodyInterruptRemainingMs(now = performance.now()): number {
    const manager = this.internalModel?.parallelMotionManager?.[0]
    if (!manager || !manager.playing || manager.isFinished()) return 0
    if (!this.currentBodyMotion || this.isMotionLooping(this.currentBodyMotion)) return 0
    const clipMs = this.currentBodyClipDurationMs
    if (!Number.isFinite(clipMs) || clipMs <= 0) return 0
    const startedAt = this.currentBodyStartedAt > now ? now : this.currentBodyStartedAt
    const playedMs = Math.max(0, now - startedAt)
    const minPlayMs = clipMs * 0.5
    return playedMs < minPlayMs ? minPlayMs - playedMs : 0
  }

  /** Start independent channels, preserving any omitted channel. Never changes visibility. */
  public async applyCharacterAction(
    action: Pick<CharacterAction, 'motion' | 'facial'>,
    signal?: AbortSignal,
    canApply?: () => boolean,
    traceSnippetIndex?: number,
    options?: { talkDurationMs?: number }
  ): Promise<void> {
    const tasks: Promise<void>[] = []
    if (action.motion) {
      const targetMotion = action.motion
      const isolated = [
        ...new Set([
          ...this.eyeParameterIds(),
          ...this.facialIsolationParamIds({
            includeEyeOpen: false,
            includeMouthOpen: true,
            includeNonEyeOpenFacial: true
          })
        ])
      ]
      const runBody = async (): Promise<void> => {
        if (targetMotion !== this.currentBodyMotion) {
          const remainingMs = this.getEarlyBodyInterruptRemainingMs()
          const talkMs = options?.talkDurationMs ?? 0
          if (remainingMs > 0 && talkMs > 0 && remainingMs < talkMs * 0.55) {
            const delayMs = Math.min(800, remainingMs)
            const genBefore = this.channelGeneration[0]
            await AnimationManager.delay(delayMs)
            if (
              this.destroyed ||
              signal?.aborted ||
              this.actionSignal.aborted ||
              genBefore !== this.channelGeneration[0] ||
              (canApply && !canApply())
            ) {
              return
            }
          }
        }
        await this.startCharacterChannel(
          0,
          targetMotion,
          isolated,
          signal,
          canApply,
          // 该手势播完后接着演下一个（同情绪族），台词期间连续表演不站桩。
          true,
          traceSnippetIndex
        )
      }
      tasks.push(runBody())
    }
    if (action.facial)
      tasks.push(
        this.startCharacterChannel(
          1,
          action.facial,
          [],
          signal,
          canApply,
          false,
          traceSnippetIndex,
          { facialForce: false }
        )
      )
    await Promise.all(tasks)
  }

  /** Cancel only queued loads/reservations, retaining the current visible pose. */
  public cancelPendingActions(): void {
    this.bodyChainArmed = false
    if (this.bodyChainTimer) {
      clearTimeout(this.bodyChainTimer)
      this.bodyChainTimer = null
    }
    for (const channel of [0, 1] as const) {
      this.channelGeneration[channel]++
      this.internalModel?.parallelMotionManager[channel]?.state.setReserved(undefined, undefined, 0)
    }
  }

  /**
   * 可见性代数：每次 LayoutAppear 递增，LayoutClear 在开始时捕获。
   * ProgressBehavior=0 的退场协程可能在后台继续，新 Appear 到来后旧协程
   * 必须停止写 alpha / 清理动作 / 移出渲染层，否则会把刚重新入场的角色淡没。
   */
  private visibilityGeneration = 0

  public beginVisibilityChange(): number {
    return ++this.visibilityGeneration
  }

  public currentVisibilityGeneration(): number {
    return this.visibilityGeneration
  }

  public isVisibilityCurrent(generation: number): boolean {
    return generation === this.visibilityGeneration
  }

  /** 直接设置淡入淡出 alpha；用于新 Appear 取消后台退场的残留淡出。 */
  public setOpacity(alpha: number): void {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0))
    this.visible = clamped > 0
    this.applyOpacityStep(clamped)
  }

  public async show(
    time: number,
    hologram: boolean,
    generation?: number,
    startMs?: number
  ): Promise<void> {
    if (generation !== undefined && !this.isVisibilityCurrent(generation)) return
    // 官方 Appear 不唤醒眨眼：唤醒只发生在非循环身体动作越过结尾时。
    this.autoBlink = true

    if (hologram) {
      this.inHologram = true
      this.visualEffectManager.applyEffect('hologram')
      this.visualEffectManager.applyEffect('triangles')
    }

    // 官方 FadeOpacityCoroutine 从当前不透明度补间到目标值；退场被新的 Appear
    // 打断时从头算 0 会闪一帧全透明。
    const startAlpha = this.getCurrentOpacity()
    this.visible = true
    this.modelOpacity = startAlpha
    this.syncModelFilters()
    // 官方 FadeOpacityCoroutine 按故事帧推进；绝对帧模式保证 act/act+frames 的边界
    // 不会因为累加步进多等一帧（Clear 766.667→783ms 的根因）。
    const fadeStartMs = startMs ?? (typeof performance !== 'undefined' ? performance.now() : 0)
    await AnimationManager.linear(
      (progress) => {
        if (generation !== undefined && !this.isVisibilityCurrent(generation)) return
        this.applyOpacityStep(startAlpha + (1 - startAlpha) * progress, true)
      },
      time,
      false,
      { startMs: fadeStartMs, frames: msToFrameCount(time) }
    )
    if (generation !== undefined && !this.isVisibilityCurrent(generation)) return
    this.applyOpacityStep(1, false)

    this.lastChangeBlinkTime = performance.now()
  }

  public async hide(time: number, generation?: number, startMs?: number): Promise<void> {
    if (generation !== undefined && !this.isVisibilityCurrent(generation)) return
    const startAlpha = this.getCurrentOpacity()
    const fadeStartMs = startMs ?? (typeof performance !== 'undefined' ? performance.now() : 0)
    await AnimationManager.linear(
      (progress) => {
        if (generation !== undefined && !this.isVisibilityCurrent(generation)) return
        this.applyOpacityStep(startAlpha * (1 - progress), true)
      },
      time,
      false,
      { startMs: fadeStartMs, frames: msToFrameCount(time) }
    )
    if (generation !== undefined && !this.isVisibilityCurrent(generation)) return

    this.visible = false
    this.applyOpacityStep(0, false)

    if (this.inHologram) {
      this.inHologram = false
      this.visualEffectManager.disableAll()
    }

    this.lastChangeBlinkTime = performance.now()
    this.autoBlink = false
    sleepBlink(this.blinkState)
    this.cancelPendingActions()
  }

  /**
   * 仅启动动作/表情：返回时动作文件已加载并开始播放（尚未播完）。
   * 供"动作必须与移动同时进行"的场景先启动动作、再启动移动，杜绝滑入滑出时的站桩空窗。
   */
  public async startMotions(
    motion?: string,
    facial?: string,
    facialFirst?: boolean,
    options: {
      bodyForce?: boolean
      facialForce?: boolean
      traceSnippetIndex?: number
      preserveActiveShortBodyMotion?: boolean
    } = {}
  ): Promise<void> {
    // 确保模型已完全加载
    if (!this.internalModel) {
      this.logger.warn('Model not fully loaded, waiting...')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    const effectiveMotion =
      options.preserveActiveShortBodyMotion &&
      motion &&
      motion !== this.currentBodyMotion &&
      this.getEarlyBodyInterruptRemainingMs() > 0
        ? undefined
        : motion

    const isolateEyes = facialFirst !== false
    const hasFacialContext = Boolean(facial || this.hasChannel1FacialActive())
    const extraIgnored =
      isolateEyes || hasFacialContext
        ? this.facialIsolationParamIds({
            includeEyeOpen: false,
            includeMouthOpen: true,
            includeNonEyeOpenFacial: true
          })
        : []

    const waits: Promise<void>[] = []
    if (facial) {
      waits.push(this.applyFacial(facial, options.facialForce === true, options.traceSnippetIndex))
    }
    if (effectiveMotion) {
      waits.push(
        this.applyMotion(
          effectiveMotion,
          isolateEyes,
          extraIgnored,
          options.traceSnippetIndex,
          options.bodyForce !== undefined ? { bodyForce: options.bodyForce } : undefined
        )
      )
    }

    await Promise.all(waits)
  }

  /** 等待当前身体动作与表情全部播完（导出模式 15s 超时兜底） */
  public async waitForMotionsFinished(): Promise<void> {
    const motion_manager = this.internalModel.parallelMotionManager[0]
    const facial_manager = this.internalModel.parallelMotionManager[1]

    const isExport = AnimationManager.isExporting()
    const timeoutMs = isExport ? 15000 : 0

    if (isExport && timeoutMs > 0) {
      let startTime = performance.now()
      let timedOut = false
      await AnimationManager.in_ticker(
        () => {},
        () => {
          if (timedOut) return true
          const now = performance.now()
          if (now < startTime) startTime = now
          if (now - startTime > timeoutMs) {
            this.logger.warn('waitForMotionsFinished timed out, forcing continue')
            timedOut = true
            try {
              motion_manager.stopAllMotions()
              facial_manager.stopAllMotions()
            } catch (e) {
              this.logger.warn('Failed to stop motions after timeout', e)
            }
            return true
          }
          return motion_manager.isFinished() && facial_manager.isFinished()
        }
      )
    } else {
      await AnimationManager.in_ticker(
        () => {},
        () => motion_manager.isFinished() && facial_manager.isFinished()
      )
    }

    this.lastChangeBlinkTime = performance.now()
  }

  public async applyAndWait(
    motion?: string,
    facial?: string,
    facialFirst?: boolean,
    traceSnippetIndex?: number
  ): Promise<void> {
    this.oneShotWaitDepth++
    try {
      await this.startMotions(motion, facial, facialFirst, { traceSnippetIndex })
      await this.waitForMotionsFinished()
    } finally {
      this.oneShotWaitDepth = Math.max(0, this.oneShotWaitDepth - 1)
    }
  }

  private alphaFilter: AlphaFilter | null = null
  private modelOpacity: number | undefined = undefined
  private characterShaderFilter: Filter | null = null
  private ambientColorFilter: Filter | null = null
  private basePositionBeforeShake: { x: number; y: number } | null = null
  private shakeGeneration = 0
  private activeCostumeName = ''

  /** 官方 `LIPSYNC_LOUD_CHARACTERS = [1, 4, 8, 12, 17, 18]`：返回 1.25 或 1.0 唇形增益。 */
  public inferCharacterId(): number | null {
    const modelPath = this._metadata?.model ?? ''
    const match = /(?:^|[/\\])(?:v\d+_)?0?([1-9]\d?)[a-z_-]/i.exec(modelPath)
    if (!match) return null
    const parsed = Number.parseInt(match[1], 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  /**
   * 模型自身的口型初值（`SetLipSyncPowKValue`）：资源名里的角色号属于
   * `LIPSYNC_LOUD_CHARACTERS`（1/4/8/12/17/18）时 1.25，否则 1.0。
   * 一次 talk 会用 `(tvs, tvs × 1.75)` 覆盖它；MSST 剧本没有 per-talk tvs，
   * 因此包络按模型初值构建。
   */
  public getLipSyncScale(): number {
    const charId = this.inferCharacterId()
    return charId !== null && LIP_LOUD_CHARACTERS.includes(charId)
      ? LIP_LOUD_TARGET_VALUE_SCALE
      : LIP_TARGET_VALUE_SCALE
  }

  public get currentCostume(): string {
    return this.activeCostumeName
  }

  public set currentCostume(name: string) {
    this.activeCostumeName = name
  }

  private getActiveVfxFilters(): Filter[] {
    const vfxFilters = (
      this.visualEffectManager as unknown as { getActiveFilters?: () => Filter[] } | undefined
    )?.getActiveFilters?.()
    return Array.isArray(vfxFilters) ? vfxFilters : []
  }

  private resolveAlphaFilter(): AlphaFilter | null {
    if (!this.alphaFilter) {
      const vfxFilters = this.getActiveVfxFilters()
      const existing = this.filters?.find(
        (f): f is AlphaFilter =>
          f instanceof AlphaFilter ||
          (f !== this.characterShaderFilter &&
            f !== this.ambientColorFilter &&
            !vfxFilters.includes(f) &&
            typeof (f as { alpha?: unknown })?.alpha === 'number')
      )
      if (existing) this.alphaFilter = existing
    }
    return this.alphaFilter
  }

  public getCurrentOpacity(): number {
    const alphaFilter = this.resolveAlphaFilter()
    if (alphaFilter && this.filters?.includes(alphaFilter)) {
      return Math.max(0, Math.min(1, alphaFilter.alpha))
    }
    if (this.modelOpacity !== undefined) {
      return this.modelOpacity
    }
    return this.visible ? 1 : 0
  }

  private shouldAttachAlphaFilter(alphaFilter: AlphaFilter): boolean {
    const opacity = this.modelOpacity ?? alphaFilter.alpha
    if (opacity >= 0.999) return false
    if (opacity <= 0 && !this.visible) return false
    return true
  }

  private applyOpacityStep(alpha: number, forceFilterWrite = false): void {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0))
    this.modelOpacity = clamped
    let alphaFilter = this.resolveAlphaFilter()
    if (!alphaFilter && clamped > 0 && clamped < 0.999) {
      alphaFilter = new AlphaFilter(clamped)
      this.alphaFilter = alphaFilter
    }
    if (alphaFilter && (forceFilterWrite || alphaFilter.alpha !== clamped)) {
      alphaFilter.alpha = clamped
    }
    this.syncModelFilters()
  }

  public syncModelFilters(): void {
    const alpha = this.resolveAlphaFilter()
    const list: Filter[] = alpha && this.shouldAttachAlphaFilter(alpha) ? [alpha] : []
    if (this.characterShaderFilter) list.push(this.characterShaderFilter)
    if (this.ambientColorFilter) list.push(this.ambientColorFilter)
    for (const effectFilter of this.getActiveVfxFilters()) {
      if (!list.includes(effectFilter)) list.push(effectFilter)
    }
    this.filters = list.length > 0 ? list : null
  }

  public setCharacterShaderFilter(filter: Filter | null): void {
    if (this.characterShaderFilter && this.characterShaderFilter !== filter) {
      this.characterShaderFilter.destroy()
    }
    this.characterShaderFilter = filter
    this.syncModelFilters()
  }

  public getCharacterShaderFilter(): Filter | null {
    return this.characterShaderFilter
  }

  public setAmbientColorFilter(filter: Filter | null): void {
    this.ambientColorFilter = filter
    this.syncModelFilters()
  }

  public setPositionRel(stage_size: [number, number], position: PositionRel): void {
    this.shakeGeneration++
    this.basePositionBeforeShake = null
    this.position.x = stage_size[0] * position.x
    this.position.y = stage_size[1] * position.y
  }

  private async runMove(
    abs_from: [number, number],
    abs_to: [number, number],
    time_ms: number,
    startMs?: number
  ): Promise<boolean> {
    if (abs_from[0] === abs_to[0] && abs_from[1] === abs_to[1]) return false
    this.shakeGeneration++
    this.basePositionBeforeShake = null

    // 官方 `CharacterMoveTo` 是 `DOLocalMove(...).SetEase(Linear)`：位置按进度线性插值。
    // 按故事帧求值（act 帧取 from，act+frames 取 to），避免片段先于帧泵启动时
    // 第一帧就被算成 1/frames，补间整体提前一帧。
    const tweenStartMs = startMs ?? (typeof performance !== 'undefined' ? performance.now() : 0)
    await AnimationManager.linear(
      (progress) => {
        // 退场（尤其是原地 Clear）可以先于上一段 Appear 的滑入完成；
        // 角色已从 layer 移除后继续写位置没有意义，也可能让帧泵 handler 抛错。
        if (this.destroyed || this.parent === null) return
        const [x, y] = interpolatePosition(abs_from, abs_to, progress)
        this.position.x = x
        this.position.y = y
      },
      time_ms,
      false,
      { startMs: tweenStartMs, frames: msToFrameCount(time_ms) }
    )
    return true
  }

  public async move(
    stage_size: [number, number],
    from: PositionRel,
    to: PositionRel,
    time_ms: number,
    startMs?: number
  ): Promise<boolean> {
    return this.runMove(
      [stage_size[0] * from.x, stage_size[1] * from.y],
      [stage_size[0] * to.x, stage_size[1] * to.y],
      time_ms,
      startMs
    )
  }

  /**
   * 官方 `move_view` 从角色**当前**位置开始（忽略 layout 的 from 字段）：
   * 同一帧排在 Move 前面的 Appear/Clear 已经改过位置时，Move 不得把它拉回旧点。
   */
  public async moveToCurrent(
    stage_size: [number, number],
    to: PositionRel,
    time_ms: number,
    startMs?: number
  ): Promise<boolean> {
    return this.runMove(
      [this.position.x, this.position.y],
      [stage_size[0] * to.x, stage_size[1] * to.y],
      time_ms,
      startMs
    )
  }

  /**
   * 官方 `SnippetActionCharacterLayout` 的 ShakeX / ShakeY：参考实现只按 duration
   * 计时，没有可见位移（`sse-bake/src/lib.rs:2137-2138` 只记录 approximation）。
   * 因此这里只等待 0.3s（18 帧），角色位置保持不变；诊断里标注为近似项。
   */
  public async shake(_axis: 'X' | 'Y', _stageWidth = 1920): Promise<void> {
    if (this.destroyed) return
    await AnimationManager.delay(CHARACTER_SHAKE_MS)
  }

  public async playMotionLastFrame(motion?: string, facial?: string): Promise<void> {
    const motion_manager = this.internalModel.parallelMotionManager[0]
    const facial_manager = this.internalModel.parallelMotionManager[1]

    this.oneShotWaitDepth++
    try {
      for (const name of [motion, facial]) {
        if (!name) continue
        const loaded = this.loadedMotion(name) as { setIsLoop?: (loop: boolean) => void } | null
        loaded?.setIsLoop?.(false)
      }

      const waits: Promise<unknown>[] = []

      if (motion) {
        waits.push(motion_manager.playMotionLastFrame(motion, 0))
      }

      if (facial) {
        waits.push(facial_manager.playMotionLastFrame(facial, 0))
      }

      const results = (await Promise.all(waits)) as boolean[]

      if (results.includes(false)) {
        await this.applyAndWait(motion, facial)
      } else {
        const isExport = AnimationManager.isExporting()
        const timeoutMs = isExport ? 15000 : 0

        if (isExport && timeoutMs > 0) {
          let startTime = performance.now()
          let timedOut = false
          await AnimationManager.in_ticker(
            () => {},
            () => {
              if (timedOut) return true
              const now = performance.now()
              if (now < startTime) startTime = now
              if (now - startTime > timeoutMs) {
                this.logger.warn(
                  `playMotionLastFrame timed out after ${timeoutMs}ms, forcing continue`
                )
                timedOut = true
                try {
                  motion_manager.stopAllMotions()
                  facial_manager.stopAllMotions()
                } catch (e) {
                  this.logger.warn('Failed to stop motions after timeout', e)
                }
                return true
              }
              return motion_manager.isFinished() && facial_manager.isFinished()
            }
          )
        } else {
          await AnimationManager.in_ticker(
            () => {},
            () => motion_manager.isFinished() && facial_manager.isFinished()
          )
        }
      }
    } finally {
      this.oneShotWaitDepth = Math.max(0, this.oneShotWaitDepth - 1)
    }
  }

  public async closeEyes(time_ms: number): Promise<void> {
    await AnimationManager.linear((progress) => {
      if (this.internalModel instanceof Cubism2InternalModel) {
        this.internalModel.eyeBlink?.setEyeParams(1 - progress)
      } else if (this.internalModel instanceof Cubism4InternalModel) {
        this.internalModel.coreModel?.setParameterValueById('ParamEyeLOpen', 1 - progress)
        this.internalModel.coreModel?.setParameterValueById('ParamEyeROpen', 1 - progress)
      } else {
        throw new Error('Not implement.')
      }
    }, time_ms)
  }

  public async openEyes(time_ms: number, max_value: number = 1): Promise<void> {
    await AnimationManager.linear((progress) => {
      if (this.internalModel instanceof Cubism2InternalModel) {
        this.internalModel.eyeBlink?.setEyeParams(progress * max_value)
      } else if (this.internalModel instanceof Cubism4InternalModel) {
        this.internalModel.coreModel?.setParameterValueById('ParamEyeLOpen', progress * max_value)
        this.internalModel.coreModel?.setParameterValueById('ParamEyeROpen', progress * max_value)
      } else {
        throw new Error('Not implement.')
      }
    }, time_ms)
  }

  public override destroy(options?: Parameters<Live2DModel['destroy']>[0]): void {
    if (this.destroyed) return
    AdvancedModel.liveInstances.delete(this)
    this.actionController.abort()
    this.cancelPendingActions()
    this.autoBlink = false
    this.restoreBodyUpdate?.()
    this.restoreBodyUpdate = null
    this.restoreFacialUpdate?.()
    this.restoreFacialUpdate = null
    const vfx = this.visualEffectManager as unknown as {
      destroy?: () => void
      disableAll?: () => void
    } | null
    if (typeof vfx?.destroy === 'function') vfx.destroy()
    else vfx?.disableAll?.()
    if (this.characterShaderFilter) {
      this.characterShaderFilter.destroy()
      this.characterShaderFilter = null
    }
    this.ambientColorFilter = null
    super.destroy(options)
  }
}

registerClockBaselineResetListener((now) => {
  AdvancedModel.resetAllClockBaselines(now)
})

export function resetClockBaselines(now = performance.now()): void {
  AdvancedModel.resetAllClockBaselines(now)
}
