export type MotionTraceEventKind =
  | 'request'
  | 'loaded'
  | 'started'
  | 'interrupted'
  | 'finished'
  | 'skipped'

export interface MotionTraceEvent {
  seq: number
  /** performance.now()；fast 模式下是虚拟时间 */
  at: number
  modelId: number
  channel: 0 | 1
  name: string
  event: MotionTraceEventKind
  snippetIndex: number
  /** 从请求到开始播放的耗时（started/loaded 事件） */
  loadMs?: number
  /** 从开始播放到被下一 cue 打断/自然结束的时长 */
  playedMs?: number
  /** motion3.json 的 Meta.Duration（秒） */
  clipDurationMs?: number
  /** 这次 cue 使用的官方混合时间（毫秒） */
  fadeMs?: number
  /** 上一段被这次 cue 打断的动作 */
  previous?: string
  reason?: string
}

/** 当前正在渲染的 snippet；AdvancedModel 记录动作追踪时带上它。 */
export const exportTraceContext = {
  snippetIndex: -1,
  snippetType: '',
  setSnippet(index: number, type: string): void {
    this.snippetIndex = index
    this.snippetType = type
  },
  reset(): void {
    this.snippetIndex = -1
    this.snippetType = ''
  }
}

export class MotionTraceCollector {
  private events: MotionTraceEvent[] = []
  private seq = 0

  reset(): void {
    this.events = []
    this.seq = 0
  }

  record(event: Omit<MotionTraceEvent, 'seq' | 'snippetIndex'> & { snippetIndex?: number }): void {
    this.events.push({
      ...event,
      seq: this.seq++,
      snippetIndex: event.snippetIndex ?? exportTraceContext.snippetIndex
    })
  }

  snapshot(): MotionTraceEvent[] {
    return [...this.events]
  }

  size(): number {
    return this.events.length
  }
}

export const motionTrace = new MotionTraceCollector()
