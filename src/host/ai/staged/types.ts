import type { RagRetrieveResult } from '../../rag/types'
import type { PersonaEntry } from '../personas'
import type { CatalogView } from '../prompt'

/**
 * 五阶段 Project SEKAI 导演流水线：
 *
 * 1. planEpisode (`cast`)：选角（2~5人；团体/活动向选3~5人）+ 规划 2~3 幕节奏表（转场/Telop/PlaceInfo/BGM 留白）；
 * 2. writeDialogue (`dialogue`)：只带入选角色人设 + 官方团体 few-shot，逐字定稿对白与句间停顿；
 * 2.5 emotion + directStaging + translateDialogue（三路并行）：
 *     - emotion：5~10 句稳态 Irodori 配音情绪分段；
 *     - directStaging：幕次阻塞走位（双人全片同场 / 多人 Normal<=2 交叠淡出淡入轮换）、Move、SE、镜头与转场；
 *     - translateDialogue：日文 ttsText 批量翻译；
 * 3. directActing (`direction`)：带完整情绪标签与分幕上下文设计动作/表情/2拍 Talk.actions/静默反应；
 * 4. composeStory + validateAndFixStory + OfficialLinter：编译官方时间线并校验硬指标。
 */

export type LlmPipeline = 'single' | 'staged' | 'agent' | 'hybrid'

export type StagedTransitionKind =
  | 'black'
  | 'sideFade'
  | 'flashback'
  | 'sekaiIn'
  | 'sekaiOut'
  | 'white'

export interface StagedScenePlan {
  id: string
  summary: string
  background: string
  ambient: 'normal' | 'evening' | 'night'
  telop?: string
  placeInfo?: string
  transitionIn: StagedTransitionKind
  isFlashback?: boolean
  isSekai?: boolean
  activeCast: string[]
  bgm?: string
  scenarioEffect?: string
}

export interface StagedCastMember {
  modelId: number
  /** 说话人绑定用的短名 */
  name: string
  fullName: string
  path: string
  /** 本场功能：发起、回应、吐槽、收尾…… */
  role: string
  isVirtualSinger?: boolean
}

export interface StagedCharacterGoal {
  /** 角色短名（与 cast.name 对应；模型省略时为空） */
  cast: string
  /** 这个角色表面想得到/想确认的东西 */
  wants: string
  /** 这个角色真正隐瞒、没说出口的顾虑 */
  hides: string
}

export interface StagedPromptUnderstanding {
  explicitRequests: string[]
  implicitSubtext: string
  relationshipDynamic: string
  emotionalArc: string
  /** 中段情绪温度发生转折的那一拍及其动因（可选，向后兼容） */
  turningPoint?: string
  /** 开场 1~4 句引入的具体日常意象/物件（可选，向后兼容） */
  openingMotif?: string
  /** 结尾 2~3 句轻描淡写回扣开场意象的方式（可选，向后兼容） */
  closingCallback?: string
  /** 各角色表面目的与内心隐瞒，用来驱动潜台词（可选，向后兼容） */
  characterGoals?: StagedCharacterGoal[]
  canonHooks: string[]
  avoidList: string[]
}

export interface StagedPairwiseAddress {
  from: string
  to: string
  zh: string
  ja?: string
}

export interface StagedRetrievalQueries {
  plot?: string
  voice?: string
  worldview?: string
}

export interface StagedCastPlan {
  title: string
  event: string
  logline: string
  outline: string[]
  cast: StagedCastMember[]
  background: string
  scenes?: StagedScenePlan[]
  /** 深度提示词理解（可选，向后兼容） */
  understanding?: StagedPromptUnderstanding
  /** 角色两两之间的官方称呼与敬语（可选，向后兼容） */
  pairwiseAddress?: StagedPairwiseAddress[]
  /** Stage 1 选角后产出的多面 RAG 检索查询（可选，向后兼容） */
  retrievalQueries?: StagedRetrievalQueries
}

export interface StagedDialogueLine {
  id: string
  speaker: string
  content: string
  /** TTS 情绪标签；未配置情绪时为空 */
  emotion?: string
  /** IrodoriTTS 逐句日语表演/韵律描述（仅描述语气/呼吸/停顿/节奏，不含年龄性别底色词） */
  ttsCaption?: string
  /** IrodoriTTS 逐句语速微调（常规 0.92~1.08，特殊高潮 0.85~1.18） */
  ttsSpeed?: number
  /** 是否为特殊戏剧高潮/崩溃/耳语场景（整场 <= 15%，仅 true 时解锁 emotion 参考音频） */
  ttsSpecialScene?: boolean
  /** 日文配音文本；翻译段在语音导演后与动作导演并行填写，合成时写入 Talk */
  ttsText?: string
  /** 所属幕次 ID（s1 / s2 / s3） */
  sceneId?: string
  /** 句前刻意停顿秒数（0 | 0.5 | 1.0 | 1.5） */
  pauseBefore?: number
  /** 本句播完后收起对话框 */
  closeWindowAfter?: boolean
  /** 对话框显示模式（如 Thinking 表示内心独白） */
  windowDisplayMode?: string
  /** Talk 效果类型（如 Internal 表示内心独白） */
  effect?: 'Normal' | 'Internal' | 'Overlap'
}

export interface StagedDialogue {
  title: string
  lines: StagedDialogueLine[]
}

export interface StagedListenerAction {
  modelId: number
  motion?: string
  facial?: string
}

export interface StagedDirectionBeat {
  at: number
  motion?: string
  facial?: string
}

export interface StagedDirectionLine {
  id: string
  motion?: string
  facial?: string
  beats?: StagedDirectionBeat[]
  listener?: StagedListenerAction
  silentMotion?: boolean
}

export interface StagedDirection {
  background: string
  /** 可选第二张背景：情绪/时间明显变化时切一次 */
  background2?: string
  /** 第二张背景从哪一句开始（台词数组下标） */
  background2From?: number
  /** 整场环境色：normal | evening | night */
  ambient: 'normal' | 'evening' | 'night'
  /** 整场 BGM（bgm.yaml 登记的文件名）；空字符串表示沿用全局默认 */
  bgm: string
  /** 可选第二首 BGM：情绪明显转折时换一次 */
  bgm2?: string
  /** 第二首 BGM 从哪一句开始（台词数组下标） */
  bgm2From?: number
  /** 结尾退场时淡出停止 BGM */
  bgmStop: boolean
  lines: StagedDirectionLine[]
}

export interface StagedStagingScene {
  id: string
  fromLineId: string
  fromIndex: number
  background: string
  ambient: 'normal' | 'evening' | 'night'
  telop?: string
  placeInfo?: string
  transitionIn: StagedTransitionKind
  isFlashback?: boolean
  isSekai?: boolean
  activeCast: number[]
  hologramCast?: number[]
  walkInCast?: number[]
  walkOutCast?: number[]
  bgm?: string
  scenarioEffect?: string
}

export interface StagedMoveCue {
  modelId: number
  kind: 'stepCloser' | 'stepBack' | 'shiftSlot'
  toSide?: 'Left' | 'Center' | 'Right'
  offset?: number
  moveSpeed?: 'Fast' | 'Normal' | 'Slow'
  motion?: string
  facial?: string
}

export interface StagedCameraCue {
  kind: 'zoomIn' | 'zoomReset' | 'pan' | 'shakeWindow' | 'shakeScreen'
  x?: number
  y?: number
  scale?: number
  durationMs?: number
}

export interface StagedSeCue {
  file: string
  volume?: number
  timing?: 'before' | 'during'
  delay?: number
}

export interface StagedStagingEvent {
  lineId: string
  lineIndex: number
  pauseBefore?: number
  closeWindowAfter?: boolean
  silentReaction?: {
    modelId: number
    motion?: string
    facial?: string
  }
  move?: StagedMoveCue
  characterShake?: { modelId: number; axis: 'X' | 'Y' }
  hologram?: { modelId: number; enabled: boolean }
  camera?: StagedCameraCue
  se?: StagedSeCue
  bgmCut?: { action: 'stop' | 'play'; file?: string; fadeMs?: number }
  stageGroup?: {
    activeCast: number[]
    walkIn?: number[]
    walkOut?: number[]
  }
}

export interface StagedStaging {
  scenes: StagedStagingScene[]
  events: StagedStagingEvent[]
}

export interface StagedPromptOptions {
  scene: string
  personas: PersonaEntry[]
  targetMinutes: number
  systemPrompt?: string
  title?: string
  /** TTS 支持的情绪标签；非空时台词稿要求每句带 emotion */
  emotionLabels?: string[]
  /** 自适应 RAG 检索结果（Pass A / Pass B），缺省或无命中时为空 */
  ragContext?: RagRetrieveResult | null
  /** hybrid 流水线前置 Agent 探索产出的核实研究简报（人设记忆、官方事件与云端素材） */
  researchBrief?: string
}

export interface StagedMessages {
  system: string
  user: string
}

export type JsonRecord = Record<string, unknown>

export interface SubtleFacialContext {
  precededByTense?: boolean
  modelPath?: string
  restrained?: boolean
  listenerPrevEmotion?: string
}

export interface QuickCastOptions {
  scene: string
  personas: PersonaEntry[]
  history?: Array<{ role: string; content: string }>
}

export interface CanonGroundingBriefOptions {
  /** 用户原始提示词：dialogue 之后的阶段原样复述，避免被 Stage 1 的概括吃掉细节 */
  scene?: string
  plan?: StagedCastPlan | null
  ragContext?: RagRetrieveResult | null
  /** cast 阶段只给事实，不给对白样本 */
  stage?: 'cast' | 'single' | 'dialogue' | 'polish' | 'staging' | 'direction' | 'voice'
  maxChars?: number
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 第二段半：语音导演（双层情绪控制：常规音色锁 + 逐句日语韵律描述 + 特殊高潮解锁）
// ---------------------------------------------------------------------------

export interface StagedEmotionSegment {
  from: number
  to: number
  emotion: string
}

export interface StagedVoiceDirectionLine {
  emotion: string
  ttsCaption?: string
  ttsSpeed?: number
  ttsSpecialScene?: boolean
}

export interface DialoguePolishOptions {
  /** 用户原始提示词：外科润色时绝不能丢掉原始诉求 */
  scene?: string
  /** 用来把说话者的人设口吻带进润色（可选） */
  view?: CatalogView
  personas?: PersonaEntry[]
  ragContext?: RagRetrieveResult | null
}

export interface StagedPresenceSegment {
  from: number
  to: number
  mode: 'solo' | 'duo' | 'trio'
  speaker?: string
  castIds?: number[]
}

// ---------------------------------------------------------------------------
// Stage 5.5：导演终审（Director Review）— 审视整场成稿的戏剧弧光、情绪连贯、音效、舞台节奏与表演自然度
// ---------------------------------------------------------------------------

export interface StagedDirectorReviewPatch {
  op: 'update_acting' | 'update_talk' | 'insert_before' | 'insert_after' | 'delete'
  index: number
  motion?: string
  facial?: string
  content?: string
  emotion?: string
  delay?: number
  closeWindowOnFinish?: boolean
  snippet?: Record<string, unknown>
}

export interface StagedDirectorActingHint {
  snippetIndex: number
  speaker: string
  issues: string[]
  recommendedFacials: string[]
  recommendedMotions: string[]
}

export interface StagedDirectorReviewHints {
  telemetrySummary?: string
  reviewFocusPoints?: string[]
  actingIssueHints?: StagedDirectorActingHint[]
}

export interface StagedDirectorReviewResult {
  dramaticArc: string
  emotionalContinuityAndVoice: string
  audioAndSeDesign: string
  stageRhythm: string
  actingNaturalness: string
  concreteFixes: string[]
  operations: StagedDirectorReviewPatch[]
}
