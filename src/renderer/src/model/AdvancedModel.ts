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
import { AlphaFilter } from 'pixi.js'
import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../utils/Logger'
import { motionTrace } from '../managers/video-export/MotionTraceCollector'
import { bodyBlendSeconds, facialBlendSeconds } from './MotionBlend'
import {
  advanceBreathDegree,
  breathParameterValue,
  createBlinkState,
  createSeededRandom,
  sleepBlink,
  stepBlink,
  wakeBlink,
  type BlinkState
} from './NaturalMotion'
import { BODY_MOTION_FADE_SECONDS, FACIAL_FADE_SECONDS } from '../../../common/official/timing'

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
  ['PARAM_EYE_BALL_X', 'ParamEyeBallX', 'ParamEyeballX'],
  ['PARAM_EYE_BALL_Y', 'ParamEyeBallY', 'ParamEyeballY'],
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
  private naturalMotionInstalled = false
  private lastNaturalUpdateMs = 0
  private firstBodyCue = true
  private facialForceNext = false
  private bodyIgnoredParamIds: string[] = []
  private restoreBodyUpdate: (() => void) | null = null
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
    this.internalModel.extendParallelMotionManager(2)
    this.installMotionIdNormalization()
    this.installBodyParameterIsolation()
    this.installCrossfade(0)
    this.installCrossfade(1)

    this.internalModel.parallelMotionManager[0].stopAllMotions()
    this.internalModel.parallelMotionManager[1].stopAllMotions()

    // 官方模型先用别的方式驱动眨眼；这里关掉依赖自带的 eyeBlink，改由 NaturalMotion 控制。
    const internalWithBlink = this.internalModel as unknown as { eyeBlink?: unknown }
    internalWithBlink.eyeBlink = undefined

    const seed = (metadata.id * 2654435761) >>> 0
    this.blinkState = createBlinkState(seed)
    this.breathDegree = createSeededRandom(seed ^ 0x6272656174)() * 360
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
    alpha_filter.resolution = 2

    this.filters = [alpha_filter]

    this.anchor.x = 0.5
    this.anchor.y = this.metadata.anchor

    this.visualEffectManager.createAll()
    this.installNaturalMotion()

    this.logger = getSubLogger(`AdvancedModel(${this._metadata.id})`)
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
        _motions?: Array<{ setFadeOut?: (seconds: number) => void }>
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
        const handle = queue.startMotion(motion, false, performance.now())
        // startMotion 会先把旧 entry 的 fadeOut 设成旧 clip 自己的值；这里统一成新 blend，
        // 让旧动作与新动作在同一个时间窗内交叉完成。
        const entries = queue._motions
        if (Array.isArray(entries)) {
          for (let i = 0; i < entries.length - 1; i++) {
            entries[i]?.setFadeOut?.(fade)
          }
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
      const dt = Math.min(0.25, Math.max(0, (now - this.lastNaturalUpdateMs) / 1000))
      this.lastNaturalUpdateMs = now
      const alpha = (this.filters?.[0] as AlphaFilter | undefined)?.alpha ?? 0
      if (!this.visible || alpha <= 0.01 || this.destroyed) return
      const opening = stepBlink(this.blinkState, dt)
      for (const id of eyeIds) {
        const base = core.getParameterValueById?.(id) ?? core.getParamFloat?.(id) ?? 1
        if (core.setParameterValueById) core.setParameterValueById(id, base * opening)
        else core.setParamFloat?.(id, base * opening)
      }
      if (this.breathParamId) {
        this.breathDegree = advanceBreathDegree(this.breathDegree, dt)
        const value = breathParameterValue(this.breathDegree)
        if (core.setParameterValueById) core.setParameterValueById(this.breathParamId, value)
        else core.setParamFloat?.(this.breathParamId, value)
      }
    })
  }

  /**
   * Wrap loadMotion so every loaded clip gets its curve ids normalized to the
   * model's actual parameter ids. Runs once per cached motion object (loadMotion
   * memoizes), before the clip is ever started.
   */
  private installMotionIdNormalization(): void {
    const internal = this.internalModel
    if (!(internal instanceof Cubism4InternalModel)) return
    const core = internal.coreModel as unknown as {
      _parameterIds?: string[]
      parameters?: { ids?: string[] }
    }
    const modelIds = core._parameterIds ?? core.parameters?.ids
    if (!modelIds?.length) return
    const idSet = new Set(modelIds)
    const motionManager = internal.motionManager
    const originalLoad = motionManager.loadMotion.bind(motionManager)
    motionManager.loadMotion = (group: string, index: number) =>
      Promise.resolve(originalLoad(group, index)).then((motion) => {
        if (motion) this.normalizeMotionParameterIds(motion, idSet)
        return motion
      })
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
      const values = this.bodyIgnoredParamIds.map((id) => ({
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
      wakeBlink(this.blinkState)
      motionTrace.record({
        at: performance.now(),
        modelId: this.metadata.id,
        snippetIndex: this.currentBodySnippetIndex,
        channel: 0,
        name: this.currentBodyMotion,
        event: 'finished',
        playedMs: performance.now() - this.currentBodyStartedAt,
        clipDurationMs: this.currentBodyClipDurationMs
      })
    }
    // 非循环身体动作播完后 Controller.WakeUp()；空闲时恢复自动眨眼。
    if (!manager.playing && manager.isFinished()) wakeBlink(this.blinkState)
    if (!this.bodyChainArmed) return
    if (!manager.isFinished() || manager.playing) return
    this.bodyChainArmed = false
    if (this.bodyChainGeneration !== this.channelGeneration[0]) return
    const alpha = (this.filters?.[0] as AlphaFilter | undefined)?.alpha ?? 0
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

  private pickChainMotion(): string | null {
    const internal = this.internalModel
    if (!internal) return null
    const definitions = internal.motionManager.definitions as Record<string, unknown> | undefined
    const all = Object.keys(definitions ?? {}).filter((name) => !name.startsWith('face_'))
    if (!all.length) return this.defaultMotionName
    const last = this.recentBodyMotions[this.recentBodyMotions.length - 1]
    // 动作名形如 w-cute-delicious01：前两段 "w-cute" 即情绪族
    const family = last ? last.split('-').slice(0, 2).join('-') : null
    let pool = family ? all.filter((name) => name.startsWith(`${family}-`)) : []
    if (pool.length <= 1) pool = all
    const recent = new Set(this.recentBodyMotions.slice(-2))
    const fresh = pool.filter((name) => !recent.has(name))
    const source = fresh.length ? fresh : pool
    return source[Math.floor(Math.random() * source.length)] ?? this.defaultMotionName
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
    if (!motion) return 0
    const data = (motion as { _motionData?: { loop?: boolean } })._motionData
    if (data?.loop) return 0
    return this.motionClipDurationMs(motion)
  }

  public isMotionLooping(name: string): boolean {
    const motion = this.loadedMotion(name)
    const data = (motion as { _motionData?: { loop?: boolean } } | null)?._motionData
    return data?.loop === true
  }

  /**
   * 入场兜底动作：剧本没给 motion/facial 时也不能站桩淡入。
   * 优先挑一个当前情绪族的 body motion；没有动作库时退回默认待机动作。
   */
  public async startEntryMotion(
    applyDefaultFacial = true,
    traceSnippetIndex?: number
  ): Promise<void> {
    const motion = this.pickChainMotion()
    if (motion) await this.applyMotion(motion, false, [], traceSnippetIndex)
    if (applyDefaultFacial && this.defaultFacialName) {
      await this.applyFacial(this.defaultFacialName, true, traceSnippetIndex)
    }
  }

  private eyeParameterIds(): string[] {
    return this.internalModel instanceof Cubism2InternalModel
      ? ['PARAM_EYE_R_OPEN', 'PARAM_EYE_L_OPEN', 'PARAM_EYE_BALL_X', 'PARAM_EYE_BALL_Y']
      : ['ParamEyeROpen', 'ParamEyeLOpen', 'ParamEyeBallX', 'ParamEyeBallY']
  }

  private async startCharacterChannel(
    channel: 0 | 1,
    name: string,
    ignoredParamIds: string[] = [],
    signal?: AbortSignal,
    canApply?: () => boolean,
    chainAfter = false,
    traceSnippetIndex?: number
  ): Promise<void> {
    const generation = ++this.channelGeneration[channel]
    if (channel === 0) {
      // legacy 入场/退场/标量 Motion 播完需要"等播完"的原语义，必须解除续演武装；
      // 只有动作 cue 与续演（chainAfter=true）才会在播完后接着演下一个。
      this.bodyChainArmed = chainAfter
      if (chainAfter) {
        this.bodyChainGeneration = generation
        this.recentBodyMotions.push(name)
        if (this.recentBodyMotions.length > 4) this.recentBodyMotions.shift()
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
    // 同一个表情已经在播时，官方 ChangeModelFacial 不会产生可见变化；
    // 重新 startMotion 还会和 MotionState 的 reservation 打架。直接视为已应用。
    if (
      channel === 1 &&
      name === this.currentFacialName &&
      manager.playing &&
      !manager.isFinished()
    ) {
      motionTrace.record({
        at: requestedAt,
        modelId: this.metadata.id,
        snippetIndex: traceSnippetIndex,
        channel,
        name,
        event: 'skipped',
        reason: 'same facial already active'
      })
      return
    }
    // Invalidate older asynchronous reservations without stopping the currently playing clip.
    manager.state.setReserved(undefined, undefined, 0)
    const motion = await internal.motionManager.loadMotion(name, 0)
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
        loadMs: loadedAt - requestedAt,
        reason: !motion
          ? 'motion not found'
          : generation !== this.channelGeneration[channel]
            ? 'superseded by a newer cue'
            : 'aborted or target hidden'
      })
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
      loadMs: loadedAt - requestedAt,
      clipDurationMs
    })
    if (channel === 0) {
      this.bodyIgnoredParamIds = ignoredParamIds
      if (this.currentBodyMotion && manager.playing && !manager.isFinished()) {
        motionTrace.record({
          at: loadedAt,
          modelId: this.metadata.id,
          snippetIndex: traceSnippetIndex,
          channel: 0,
          name: this.currentBodyMotion,
          event: 'interrupted',
          playedMs: loadedAt - this.currentBodyStartedAt,
          clipDurationMs: this.currentBodyClipDurationMs,
          previous: name
        })
      }
    }
    // 官方 PlayableAnimator 是交叉淡化，不是先 stopAll 清空旧姿势。
    const fadeSeconds =
      channel === 0
        ? this.firstBodyCue || this.currentBodyMotion === this.defaultMotionName
          ? 0
          : bodyBlendSeconds(this.currentBodyMotion, name)
        : this.facialForceNext
          ? facialBlendSeconds(true)
          : facialBlendSeconds(false)
    this.channelFadeSeconds[channel] = fadeSeconds
    if (channel === 0) {
      // ChangeMotionCore 结束时 Sleep()：动作播放期间不自动眨眼，动作结束再 Wake。
      sleepBlink(this.blinkState)
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
        loadMs: startedAt - requestedAt,
        clipDurationMs,
        fadeMs: Math.round(fadeSeconds * 1000),
        reason: started ? undefined : 'motion manager refused the cue'
      })
      if (started && channel === 0) {
        this.currentBodyMotion = name
        this.currentBodySnippetIndex = traceSnippetIndex ?? -1
        this.currentBodyStartedAt = startedAt
        this.currentBodyClipDurationMs = clipDurationMs
        this.bodyFinishReported = false
        this.firstBodyCue = false
      }
      if (started && channel === 1) {
        this.facialForceNext = false
        this.currentFacialName = name
      }
    } finally {
      signal?.removeEventListener('abort', invalidateReservation)
    }
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
    traceSnippetIndex?: number
  ): Promise<void> {
    await this.startCharacterChannel(
      0,
      motion,
      [...(ignoreParams ? this.eyeParameterIds() : []), ...extraIgnoreParamIds],
      undefined,
      undefined,
      false,
      traceSnippetIndex
    )
  }

  public async applyFacial(
    facial: string,
    force = false,
    traceSnippetIndex?: number
  ): Promise<void> {
    this.facialForceNext = force
    try {
      await this.startCharacterChannel(
        1,
        facial,
        [],
        undefined,
        undefined,
        false,
        traceSnippetIndex
      )
    } finally {
      this.facialForceNext = false
    }
  }

  /** Start independent channels, preserving any omitted channel. Never changes visibility. */
  public async applyCharacterAction(
    action: Pick<CharacterAction, 'motion' | 'facial'>,
    signal?: AbortSignal,
    canApply?: () => boolean,
    traceSnippetIndex?: number
  ): Promise<void> {
    const tasks: Promise<void>[] = []
    if (action.motion) {
      tasks.push(
        this.startCharacterChannel(
          0,
          action.motion,
          [
            ...this.eyeParameterIds(),
            this.internalModel instanceof Cubism2InternalModel
              ? 'PARAM_MOUTH_OPEN_Y'
              : 'ParamMouthOpenY'
          ],
          signal,
          canApply,
          // 该手势播完后接着演下一个（同情绪族），台词期间连续表演不站桩。
          true,
          traceSnippetIndex
        )
      )
    }
    if (action.facial)
      tasks.push(
        this.startCharacterChannel(1, action.facial, [], signal, canApply, false, traceSnippetIndex)
      )
    await Promise.all(tasks)
  }

  /** Cancel only queued loads/reservations, retaining the current visible pose. */
  public cancelPendingActions(): void {
    this.bodyChainArmed = false
    for (const channel of [0, 1] as const) {
      this.channelGeneration[channel]++
      this.internalModel?.parallelMotionManager[channel]?.state.setReserved(undefined, undefined, 0)
    }
  }

  public async show(time: number, hologram: boolean): Promise<void> {
    this.autoBlink = true

    if (hologram) {
      this.inHologram = true
      this.visualEffectManager.applyEffect('hologram')
      this.visualEffectManager.applyEffect('triangles')
    }

    await AnimationManager.linear((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = progress
    }, time)

    this.lastChangeBlinkTime = Date.now()
  }

  public async hide(time: number): Promise<void> {
    await AnimationManager.linear((progress) => {
      const alpha_filter: AlphaFilter = this.filters![0] as AlphaFilter
      alpha_filter.alpha = 1 - progress
    }, time)

    if (this.inHologram) {
      this.inHologram = false
      this.visualEffectManager.disableAll()
    }

    this.lastChangeBlinkTime = Date.now()
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
    options: { facialForce?: boolean; traceSnippetIndex?: number } = {}
  ): Promise<void> {
    // 确保模型已完全加载
    if (!this.internalModel) {
      this.logger.warn('Model not fully loaded, waiting...')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    const waits: Promise<void>[] = []
    if (motion) {
      waits.push(this.applyMotion(motion, facialFirst, [], options.traceSnippetIndex))
    }
    if (facial) {
      waits.push(this.applyFacial(facial, options.facialForce === true, options.traceSnippetIndex))
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
      const startTime = performance.now()
      let timedOut = false
      await AnimationManager.in_ticker(
        () => {},
        () => {
          if (timedOut) return true
          if (performance.now() - startTime > timeoutMs) {
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

    this.lastChangeBlinkTime = Date.now()
  }

  public async applyAndWait(
    motion?: string,
    facial?: string,
    facialFirst?: boolean,
    traceSnippetIndex?: number
  ): Promise<void> {
    await this.startMotions(motion, facial, facialFirst, { traceSnippetIndex })
    await this.waitForMotionsFinished()
  }

  public setPositionRel(stage_size: [number, number], position: PositionRel): void {
    this.position.set(stage_size[0] * position.x, stage_size[1] * (position.y + 0.3))
  }

  public async move(
    stage_size: [number, number],
    from: PositionRel,
    to: PositionRel,
    time_ms: number
  ): Promise<void> {
    if (from.x === to.x && from.y === to.y) return

    const abs_from: [number, number] = [stage_size[0] * from.x, stage_size[1] * (from.y + 0.3)]
    const abs_to: [number, number] = [stage_size[0] * to.x, stage_size[1] * (to.y + 0.3)]

    await AnimationManager.linear((progress) => {
      this.position.x = (abs_to[0] - abs_from[0]) * progress + abs_from[0]
      this.position.y = (abs_to[1] - abs_from[1]) * progress + abs_from[1]
    }, time_ms)
  }

  public async playMotionLastFrame(motion?: string, facial?: string): Promise<void> {
    const motion_manager = this.internalModel.parallelMotionManager[0]
    const facial_manager = this.internalModel.parallelMotionManager[1]

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
        const startTime = performance.now()
        let timedOut = false
        await AnimationManager.in_ticker(
          () => {},
          () => {
            if (timedOut) return true
            if (performance.now() - startTime > timeoutMs) {
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
    this.actionController.abort()
    this.cancelPendingActions()
    this.autoBlink = false
    this.restoreBodyUpdate?.()
    this.restoreBodyUpdate = null
    this.visualEffectManager.disableAll()
    super.destroy(options)
  }
}
