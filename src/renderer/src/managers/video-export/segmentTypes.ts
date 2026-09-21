/**
 * Talk 片段时长补丁（fast / parallel 共用，保证两条路径时间轴一致）：
 * duration = max(原估算, tts 时长 + 尾垫)，并把后续所有片段整体后移。
 * 返回新的 duration（未变化时与原值相同）。
 */
export function applyTalkPatch(
  timeline: Array<{
    snippetIndex: number
    startTimeMs: number
    durationMs: number
    endTimeMs: number
    ttsDurationMs: number
    hasTTS: boolean
  }>,
  index: number,
  ttsDurationMs: number,
  fallbackMs?: number
): number {
  const entry = timeline[index]
  if (!entry) return 0
  const target =
    ttsDurationMs > 0
      ? Math.max(entry.durationMs, ttsDurationMs + TALK_TAIL_SILENCE_MS)
      : fallbackMs && fallbackMs > entry.durationMs
        ? fallbackMs
        : entry.durationMs
  if (target <= entry.durationMs) return entry.durationMs

  const durationDelta = target - entry.durationMs
  timeline[index] = {
    ...entry,
    ttsDurationMs: ttsDurationMs > 0 ? ttsDurationMs : entry.ttsDurationMs,
    hasTTS: ttsDurationMs > 0 ? true : entry.hasTTS,
    durationMs: target,
    endTimeMs: entry.startTimeMs + target
  }
  for (let j = index + 1; j < timeline.length; j++) {
    timeline[j] = {
      ...timeline[j],
      startTimeMs: timeline[j].startTimeMs + durationDelta,
      endTimeMs: timeline[j].endTimeMs + durationDelta
    }
  }
  return target
}

/** 台词音频结束后的静音尾垫：保证相邻对话之间有呼吸间隔（与 fast 路径一致） */
const TALK_TAIL_SILENCE_MS = 600

/**
 * 分段并行渲染（parallel 导出模式）的共享类型。
 *
 * 架构：编排页（收到 api:start-export 的 worker）预合成 TTS 并切分段落，
 * 宿主把每段派给不同 worker 页并行渲染；各段产出独立 mp4，
 * 最后由宿主用 ffmpeg concat 无损拼接并混音。
 */

/** 一个渲染段：[fromSnippet, toSnippet) 的片段区间，计划起始时间为 startTimeMs */
export interface SegmentSpec {
  index: number
  fromSnippet: number
  toSnippet: number
  /** 计划起始时间（毫秒，相对整片起点，来自定稿时间轴） */
  startTimeMs: number
}

/** 段渲染结果（页面 → 宿主） */
export interface SegmentResult {
  index: number
  success: boolean
  videoPath?: string
  /** 实际开始抓帧的虚拟时间（毫秒）——live2d 动作可能比时间轴略长，用实测值对齐音频 */
  actualStartMs: number
  /** 段内各 Talk 的相对时间（毫秒，相对段起点） */
  talkPlacements: Array<{
    snippetIndex: number
    startMs: number
    endMs: number
    speaker?: string
    content?: string
    ttsDurationMs?: number
  }>
  frameCount: number
  error?: string
}

/** 编排页 → 宿主的分段计划 */
export interface ParallelPlanPayload {
  taskId: string
  segments: SegmentSpec[]
  /** 定稿时间轴（TTS 已并入），各段页面直接复用，不再运行时补丁 */
  timeline: Array<{
    snippetIndex: number
    snippetType: string
    startTimeMs: number
    durationMs: number
    endTimeMs: number
    ttsDurationMs: number
    hasTTS: boolean
  }>
  totalDurationMs: number
}

/** 宿主 → 编排页：全部段落完成（含各段实测起点） */
export interface ParallelSegmentsDonePayload {
  taskId: string
  segments: Array<{
    index: number
    videoPath: string
    actualStartMs: number
    talkPlacements: SegmentResult['talkPlacements']
    frameCount: number
  }>
  totalDurationMs: number
}

/** 宿主 → 编排页：某段重试后仍失败，请编排页自行兜底渲染 */
export interface ParallelSegmentFailedPayload {
  taskId: string
  index: number
  error: string
}

/** 宿主 → worker 页的段渲染任务 */
export interface RenderSegmentPayload {
  taskId: string
  segmentIndex: number
  fromSnippet: number
  toSnippet: number
  startTimeMs: number
  timeline: ParallelPlanPayload['timeline']
  outputPath: string
  videoConfig: {
    width: number
    height: number
    renderScale: number
    fps: number
    codec: string
    crf: number
    audioBitrate: string
    watermark?: boolean
    exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
    exportBitrate?: number
  }
}

/**
 * 切点规划：在「无动画在途」的片段边界上切（BlackIn 优先）。
 *
 * 为什么能任意切：
 * 每段 worker 都会先用虚拟时钟把 [0, fromSnippet) 的前序片段完整跑一遍
 * （同样的 handleSnippet 逻辑、同样的帧率步进，只是不抓帧），
 * 到达切点时的场景状态（模型位置/背景/对话框/表情/动作）与顺序渲染一致。
 * 因此不需要依赖黑场；BlackIn 只是「切了也完全看不见」的加分项。
 *
 * 安静边界定义：前一个片段不处于持续动画中（Motion/Move/LayoutAppear/
 * Talk/Telop/ChangeBackgroundImage/BlackOut 自身都带等待动画，
 * 但它们在自己的片段内就会播完；此处排除紧邻其后的边界以避免
 * 「动画刚结束、物理还没稳定」的点，并优先选择视觉稳定的边界）。
 */
const ANIMATING_TYPES = new Set([
  'Motion',
  'Move',
  'LayoutAppear',
  'Talk',
  'Telop',
  'ChangeBackgroundImage',
  'BlackOut',
  'BlackIn',
  'DoParam'
])

export function planSegments(
  snippets: Array<{ type: string; wait?: boolean }>,
  timeline: Array<{ snippetIndex: number; startTimeMs: number; endTimeMs: number }>,
  maxSegments: number
): SegmentSpec[] {
  const total = snippets.length
  if (total === 0) return [{ index: 0, fromSnippet: 0, toSnippet: 0, startTimeMs: 0 }]
  if (maxSegments <= 1 || total < 4) {
    return [{ index: 0, fromSnippet: 0, toSnippet: total, startTimeMs: 0 }]
  }

  const totalMs = timeline.length > 0 ? timeline[timeline.length - 1].endTimeMs : 0
  if (totalMs <= 0) {
    return [{ index: 0, fromSnippet: 0, toSnippet: total, startTimeMs: 0 }]
  }
  const targetMs = totalMs / maxSegments

  // 候选切点：安静边界（前一片段不带动画），BlackIn 额外优先
  const candidates: Array<{ snippet: number; blackIn: boolean }> = []
  for (let i = 2; i < total - 1; i++) {
    const prev = snippets[i - 1]
    const isBlackIn = snippets[i].type === 'BlackIn'
    const quiet = !ANIMATING_TYPES.has(prev.type)
    if (isBlackIn || quiet) {
      candidates.push({ snippet: i, blackIn: isBlackIn })
    }
  }
  if (candidates.length === 0) {
    return [{ index: 0, fromSnippet: 0, toSnippet: total, startTimeMs: 0 }]
  }

  const cuts: number[] = []
  let nextTarget = targetMs
  for (const candidate of candidates) {
    if (cuts.length >= maxSegments - 1) break
    const entry = timeline.find((t) => t.snippetIndex === candidate.snippet)
    if (!entry) continue
    // 普通安静边界要求达到目标时长；BlackIn 可略微提前（切了也看不见）
    const threshold = candidate.blackIn ? nextTarget * 0.85 : nextTarget
    if (entry.startTimeMs >= threshold) {
      cuts.push(candidate.snippet)
      nextTarget = entry.startTimeMs + targetMs
    }
  }

  if (cuts.length === 0) {
    return [{ index: 0, fromSnippet: 0, toSnippet: total, startTimeMs: 0 }]
  }

  const boundaries = [0, ...cuts, total]
  const segments: SegmentSpec[] = []
  for (let s = 0; s < boundaries.length - 1; s++) {
    const from = boundaries[s]
    const to = boundaries[s + 1]
    const entry = timeline.find((t) => t.snippetIndex === from)
    segments.push({
      index: s,
      fromSnippet: from,
      toSnippet: to,
      startTimeMs: entry ? entry.startTimeMs : 0
    })
  }
  return segments
}
