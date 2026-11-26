import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { ILogObj, Logger } from 'tslog'
import type { ExportDiagnostics } from '../../common/types/ExportDiagnostics'
import type { ExportTask } from '../servers/VideoApiServer'
import type { ExportResultPayload, PreparedSegmentPlan } from '../pool/renderPool'
import { planRustSegments, runRustConcatSegments } from './rustExporter'
import { normalizeVideoCodec, type VideoCodec } from '../../shared/ffmpeg'

const MIN_PARALLEL_SEGMENT_FRAMES = 300

export interface SegmentPoolAdapter {
  dispatchSubTask(task: ExportTask): Promise<ExportResultPayload>
  cancelSubTask(taskId: string): Promise<void>
  readyWorkerCount(): number
  onTaskComplete(taskId: string, result: ExportResultPayload): void
}

interface ActiveSegmentJob {
  taskId: string
  sharedDir: string
  subTaskIds: Set<string>
  cancelled: boolean
}

function splitSegmentsFallback(start: number, end: number, jobs: number): Array<{ start: number; end: number }> {
  const frames = Math.max(0, end - start)
  const n = Math.max(1, Math.min(jobs, Math.max(1, Math.floor(frames / MIN_PARALLEL_SEGMENT_FRAMES))))
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < n; i++) {
    const s = start + Math.floor((frames * i) / n)
    const e = start + Math.floor((frames * (i + 1)) / n)
    out.push({ start: s, end: e })
  }
  return out
}

/**
 * Coordinates Rust-planned multi-segment parallel rendering across RenderPool workers:
 * 1. Single-pass prepare on 1 worker (parallel TTS synthesis once, deterministic virtual-clock
 *    timeline bake, and single WAV mix into sharedDir).
 * 2. Rust `plan-segments` GOP-aligned partitioning into K ranges.
 * 3. Parallel worker segment rendering (fast-advancing virtual clock to `startFrame` without
 *    rendering/encoding pre-segment frames).
 * 4. Rust `concat-mix` lossless `-c:v copy` + BT.709 VUI tagging + AAC audio mux.
 */
export class SegmentCoordinator {
  private readonly jobs = new Map<string, ActiveSegmentJob>()
  private readonly subTaskToParent = new Map<string, string>()

  constructor(
    private readonly logger: Logger<ILogObj>,
    private readonly pool: SegmentPoolAdapter
  ) {}

  hasJob(taskId: string): boolean {
    return this.jobs.has(taskId)
  }

  isSubTask(taskId: string): boolean {
    return this.subTaskToParent.has(taskId)
  }

  shouldUseParallelSegments(task: ExportTask): boolean {
    const requestedJobs = Math.max(1, task.videoConfig.exportJobs ?? 1)
    if (requestedJobs <= 1) return false
    if (this.pool.readyWorkerCount() < 2) return false
    const snippets = task.story?.snippets ?? []
    if (snippets.length < 4) return false
    const estimatedSec = snippets.reduce((sum, s) => {
      const delay = typeof s.delay === 'number' && Number.isFinite(s.delay) ? s.delay : 0
      const textLen =
        s.type === 'Talk' && s.data && typeof (s.data as { content?: unknown }).content === 'string'
          ? (s.data as { content: string }).content.length
          : 0
      return sum + Math.max(delay, textLen > 0 ? Math.max(1.2, textLen * 0.08) : 0)
    }, 0)
    const fps = Math.max(1, Math.min(task.videoConfig.fastFps ?? 30, task.videoConfig.fps ?? 60))
    return estimatedSec * fps >= MIN_PARALLEL_SEGMENT_FRAMES * 2
  }

  start(task: ExportTask): void {
    void this.run(task)
  }

  async cancel(taskId: string): Promise<void> {
    const job = this.jobs.get(taskId)
    if (!job) return
    job.cancelled = true
    const subIds = Array.from(job.subTaskIds)
    await Promise.allSettled(subIds.map((subId) => this.pool.cancelSubTask(subId)))
    for (const subId of subIds) {
      this.subTaskToParent.delete(subId)
    }
    this.jobs.delete(taskId)
    await fs.promises.rm(job.sharedDir, { recursive: true, force: true }).catch(() => {})
  }

  async cancelAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.jobs.keys()).map((id) => this.cancel(id)))
  }

  private async dispatchTracked(job: ActiveSegmentJob, subTask: ExportTask): Promise<ExportResultPayload> {
    if (job.cancelled) {
      return { taskId: subTask.taskId, success: false, error: 'Export cancelled by user' }
    }
    job.subTaskIds.add(subTask.taskId)
    this.subTaskToParent.set(subTask.taskId, job.taskId)
    try {
      return await this.pool.dispatchSubTask(subTask)
    } finally {
      job.subTaskIds.delete(subTask.taskId)
      this.subTaskToParent.delete(subTask.taskId)
    }
  }

  private async run(task: ExportTask): Promise<void> {
    const wallStart = Date.now()
    const sharedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mss-segs-'))
    const job: ActiveSegmentJob = {
      taskId: task.taskId,
      sharedDir,
      subTaskIds: new Set(),
      cancelled: false
    }
    this.jobs.set(task.taskId, job)

    try {
      const remainingTimeout = (): number =>
        Math.max(30_000, task.addedAt + task.timeoutMs - Date.now())

      // Phase 1: Single-pass prepare (parallel TTS once, exact frame plan, single WAV mix)
      const prepTask: ExportTask = {
        ...task,
        taskId: `${task.taskId}__prep`,
        addedAt: Date.now(),
        timeoutMs: remainingTimeout(),
        videoConfig: {
          ...task.videoConfig,
          segmentPrepareOnly: true,
          segmentSharedDir: sharedDir
        }
      }
      const prepRes = await this.dispatchTracked(job, prepTask)
      if (job.cancelled) return
      if (!prepRes.success || !prepRes.prepared) {
        throw new Error(prepRes.error || 'Segment prepare phase failed')
      }

      const prepared: PreparedSegmentPlan = prepRes.prepared
      const totalFrames = Math.max(1, prepared.totalFrames)
      const encodeFps = Math.max(1, prepared.encodeFps)
      const requestedJobs = Math.max(1, task.videoConfig.exportJobs ?? 1)
      const effectiveJobs = Math.max(1, Math.min(requestedJobs, this.pool.readyWorkerCount()))

      const planned =
        (await planRustSegments(0, totalFrames, effectiveJobs, encodeFps)) ??
        splitSegmentsFallback(0, totalFrames, effectiveJobs)
      const segments = planned.filter((s) => s.end > s.start)
      if (segments.length === 0) {
        throw new Error(`Segment planner produced 0 valid segments for ${totalFrames} frames`)
      }

      this.logger.info(
        `[SegmentCoordinator] Task ${task.taskId}: totalFrames=${totalFrames}@${encodeFps}fps -> ${segments.length} segments: ${segments
          .map((s) => `[${s.start},${s.end})`)
          .join(', ')}`
      )

      // Phase 2: Parallel segment rendering across ready workers
      const runSegment = async (
        seg: { start: number; end: number },
        idx: number,
        attempt: number
      ): Promise<{ result: ExportResultPayload; videoPath: string; frames: number }> => {
        const segOutPath = path.join(sharedDir, `seg-${idx}-try${attempt}.mp4`)
        const segTask: ExportTask = {
          ...task,
          taskId: `${task.taskId}__seg${idx}_a${attempt}`,
          addedAt: Date.now(),
          timeoutMs: remainingTimeout(),
          videoConfig: {
            ...task.videoConfig,
            segmentSharedDir: sharedDir,
            segmentRange: {
              index: idx,
              count: segments.length,
              startFrame: seg.start,
              endFrame: seg.end,
              totalFrames,
              encodeFps,
              outputPath: segOutPath,
              precomputedTts: prepared.ttsWavs
            }
          }
        }
        const res = await this.dispatchTracked(job, segTask)
        if (job.cancelled) {
          throw new Error('Export cancelled by user')
        }
        if (!res.success || !res.videoPath) {
          throw new Error(res.error || `Segment ${idx} failed`)
        }
        return {
          result: res,
          videoPath: res.videoPath,
          frames: seg.end - seg.start
        }
      }

      const segOutputs = await Promise.all(
        segments.map(async (seg, idx) => {
          try {
            return await runSegment(seg, idx, 0)
          } catch (firstErr) {
            if (job.cancelled) throw firstErr
            this.logger.warn(
              `[SegmentCoordinator] Segment ${idx} failed on first attempt, retrying once:`,
              firstErr
            )
            return runSegment(seg, idx, 1)
          }
        })
      )
      if (job.cancelled) return

      // Phase 3: Rust lossless ffconcat + BT.709 VUI tagging + AAC audio mux
      const detectedCodec: VideoCodec = normalizeVideoCodec(
        segOutputs[0]?.result.segmentCodec ?? task.videoConfig.codec
      )
      const concatStart = Date.now()
      const concatRes = await runRustConcatSegments({
        outputPath: task.outputPath,
        fps: encodeFps,
        codec: detectedCodec,
        audioPath: prepared.audioFilePath,
        audioBitrate: task.videoConfig.audioBitrate || '128k',
        segments: segOutputs.map((s) => ({
          videoPath: s.videoPath,
          frameCount: s.frames
        }))
      })
      const invokeMs = Date.now() - concatStart
      if (job.cancelled) {
        await fs.promises.rm(task.outputPath, { force: true }).catch(() => {})
        return
      }

      const wallMs = Date.now() - wallStart
      const maxSegRenderMs = segOutputs.reduce(
        (m, s) => Math.max(m, s.result.timings?.renderMs ?? 0),
        0
      )
      const sumSegRenderMs = segOutputs.reduce(
        (sum, s) => sum + (s.result.timings?.renderMs ?? 0),
        0
      )
      const maxSegPumpMs = segOutputs.reduce(
        (m, s) => Math.max(m, s.result.timings?.pumpMs ?? 0),
        0
      )
      const maxSegTickMs = segOutputs.reduce(
        (m, s) => Math.max(m, s.result.timings?.tickMs ?? 0),
        0
      )
      const maxSegSnapshotMs = segOutputs.reduce(
        (m, s) => Math.max(m, s.result.timings?.snapshotMs ?? 0),
        0
      )
      const anyFfmpegConvert = segOutputs.some((s) => s.result.segmentConvert === 'ffmpeg')
      const encoderLabel =
        segOutputs[0]?.result.segmentCodec === 'hevc'
          ? anyFfmpegConvert
            ? 'webcodecs-hevc+ffmpeg'
            : 'webcodecs-hevc'
          : anyFfmpegConvert
            ? 'webcodecs-h264+ffmpeg'
            : 'webcodecs-h264'
      const videoDurationMs = Math.round((totalFrames / encodeFps) * 1000)

      const mergedTimings: Record<string, number> = {
        pumpMs: Math.round(maxSegPumpMs),
        tickMs: Math.round(maxSegTickMs),
        renderMs: Math.round(maxSegRenderMs),
        sumSegmentRenderMs: Math.round(sumSegRenderMs),
        snapshotMs: Math.round(maxSegSnapshotMs),
        ttsSetupMs: Math.round(prepared.timings?.ttsSetupMs ?? 0),
        ttsWaitMs: 0,
        encodeMs: Math.round(
          segOutputs.reduce((m, s) => Math.max(m, s.result.timings?.encodeMs ?? 0), 0)
        ),
        audioMs: Math.round(prepared.timings?.audioMs ?? 0),
        invokeMs: Math.round(invokeMs),
        frames: totalFrames,
        encodedFrames: totalFrames,
        videoDurationMs,
        wallMs,
        avgPumpFps: maxSegPumpMs > 0 ? Math.round((totalFrames / (maxSegPumpMs / 1000)) * 10) / 10 : 0
      }

      const diagnostics: ExportDiagnostics | undefined = prepared.diagnostics
        ? {
            ...prepared.diagnostics,
            export: {
              ...prepared.diagnostics.export,
              frameCount: totalFrames,
              durationMs: videoDurationMs,
              outputSize: concatRes.fileSize,
              timings: mergedTimings,
              encoder: encoderLabel,
              segments: segments.length,
              convert: anyFfmpegConvert ? 'ffmpeg' : 'browser',
              color: 'bt709/tv'
            }
          }
        : undefined

      this.jobs.delete(task.taskId)
      this.pool.onTaskComplete(task.taskId, {
        taskId: task.taskId,
        success: true,
        videoPath: task.outputPath,
        duration: videoDurationMs / 1000,
        frameCount: totalFrames,
        outputSize: concatRes.fileSize,
        timings: mergedTimings,
        diagnostics
      })
    } catch (error) {
      const wasCancelled = job.cancelled
      this.jobs.delete(task.taskId)
      if (!wasCancelled) {
        this.pool.onTaskComplete(task.taskId, {
          taskId: task.taskId,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      await fs.promises.rm(sharedDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
