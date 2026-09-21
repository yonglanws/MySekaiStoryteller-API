import { App } from '../app/App'
import AnimationManager from './AnimationManager'
import { Ticker } from 'pixi.js'
import {
  ExportLogger,
  CheckpointManager,
  ProgressTracker,
  ErrorRecoveryManager,
  ExportError,
  ExportErrorCode,
  ExportResult,
  StreamRecorder,
  AudioMuxer,
  ConcurrentExportPipeline,
  SnippetTimestampRecorder,
  AsyncFrameCapturer
} from './video-export'
import { VirtualClockController } from './video-export/VirtualClockController'
import { WebCodecsMp4Encoder } from './video-export/WebCodecsMp4Encoder'
import { JpegFrameSink } from './video-export/JpegFrameSink'
import { applyTalkPatch } from './video-export/talkPatch'
import type { VideoExportOptions } from './video-export'
import type { ExportProgress as ExtendedExportProgress } from './video-export'
import type { SnippetData } from '../../../common/types/Story'
import type { SnippetTimelineEntry } from './TTSManager'
import { estimateSnippetDuration } from '../utils/TimelineCalculator'
import { webGLValidator } from '../utils/WebGLContextValidator'
import { frameValidator } from '../utils/FrameContentValidator'
import { resolveBgmUrl } from '../utils/ResourceUrl'

export { VideoExportOptions }
export interface ExportProgress {
  stage: 'initializing' | 'loading' | 'capturing' | 'encoding' | 'saving' | 'complete'
  current: number
  total: number
  message: string
}

type ProgressCallback = (progress: ExportProgress) => void
type InternalProgressCallback = (progress: ExtendedExportProgress) => void

/** 台词音频结束后的静音尾垫：保证相邻对话之间有呼吸间隔 */
const TTS_TAIL_SILENCE_MS = 600

/** 解析 '128k' / '128000' 形式的码率为 bps */
function parseBitrateBps(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k?)$/)
  if (!match) return 128000
  return match[2] === 'k' ? Math.round(parseFloat(match[1]) * 1000) : Math.round(parseFloat(match[1]))
}

/** 目标体积反推码率的下限：再低画质不可接受 */
const MIN_TARGET_BITRATE_BPS = 600_000

export default class VideoExportManager {
  private readonly logger: ExportLogger
  private readonly checkpointManager: CheckpointManager
  private readonly errorRecovery: ErrorRecoveryManager
  private readonly progressTracker: ProgressTracker

  private readonly app: App
  private isAborted: boolean = false
  private abortController: AbortController | null = null

  private static readonly DEFAULT_BATCH_SIZE = 30

  constructor(app: App) {
    this.app = app
    this.logger = new ExportLogger('VideoExportManager')
    this.checkpointManager = new CheckpointManager()
    this.errorRecovery = new ErrorRecoveryManager(3)
    this.progressTracker = new ProgressTracker()
  }

  public abort(): void {
    this.isAborted = true
    this.abortController?.abort()
    this.logger.info('Export aborted by user')
  }

  private resetState(): void {
    this.isAborted = false
    this.abortController = new AbortController()
    this.errorRecovery.reset()
    this.checkpointManager.clearCheckpoint()
  }

  private checkAborted(): void {
    if (this.isAborted) {
      throw ExportError.cancelled()
    }
  }

  private async yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async requestAnimationFrameOnce(): Promise<void> {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve(undefined))
    })
  }

  private createProgressAdapter(onProgress?: ProgressCallback): InternalProgressCallback {
    return (progress: ExtendedExportProgress) => {
      if (onProgress) {
        onProgress({
          stage: progress.stage as ExportProgress['stage'],
          current: progress.current,
          total: progress.total,
          message: progress.message
        })
      }
    }
  }

  private async executeSnippet(snippet: SnippetData): Promise<void> {
    await this.app.snippetStrategyManager.handleSnippetForExport(snippet)
  }

  private async processSnippetFrames(
    snippet: SnippetData,
    _index: number,
    fps: number,
    canvas: HTMLCanvasElement,
    capturer: AsyncFrameCapturer
  ): Promise<number> {
    const originalDurationMs = Math.round(snippet.delay * 1000)
    const frameIntervalMs = 1000 / fps
    const targetFrameCount = Math.max(1, Math.round(originalDurationMs / frameIntervalMs))

    await this.executeSnippet(snippet)

    const capturePromises: Promise<void>[] = []
    const batchLimit = 60

    for (let f = 0; f < targetFrameCount; f++) {
      capturePromises.push(capturer.captureFrameAsync(canvas))

      if ((f + 1) % batchLimit === 0) {
        await Promise.all(capturePromises)
        capturePromises.length = 0
        await this.yieldToBrowser()
      }
    }

    if (capturePromises.length > 0) {
      await Promise.all(capturePromises)
    }

    return targetFrameCount
  }

  async exportVideo(
    options: VideoExportOptions,
    onProgress?: ProgressCallback
  ): Promise<ExportResult> {
    this.resetState()

    const startTime = performance.now()
    const progressCallback = this.createProgressAdapter(onProgress)
    const isApiMode = options.apiMode === true

    let overlay: HTMLElement | null = null
    let progressFill: HTMLDivElement | null = null
    let exportStatus: HTMLElement | null = null

    if (!isApiMode) {
      overlay = document.getElementById('export-overlay')
      progressFill = document.getElementById('progressFill') as HTMLDivElement | null
      exportStatus = document.getElementById('exportStatus')
      if (overlay) overlay.hidden = false
    }

    try {
      this.logger.info('Starting video export', { ...options, apiMode: isApiMode })

      this.progressTracker.start()
      this.app.exporting = true

      await this.initializeExport(options, progressFill, exportStatus, progressCallback)
      this.checkAborted()

      if (options.exportMode === 'stream') {
        const maxRetries = 2
        let lastError: Error | null = null
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            if (attempt > 0) {
              this.logger.info(`Retrying stream export, attempt ${attempt + 1}/${maxRetries + 1}`)
              if (exportStatus)
                exportStatus.textContent = `重试导出 (${attempt + 1}/${maxRetries + 1})…`

              this.app.lastSnippetActualDurationMs = 0
              this.app.ttsManager?.clearAudioTracks()

              await this.sleep(1000)
            }
            return await this.exportVideoStream(
              options,
              progressFill,
              exportStatus,
              progressCallback
            )
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
            const errorMsg = lastError.message
            const isNotReadable =
              errorMsg.includes('NotReadableError') || errorMsg.includes('could not be read')
            const isContextLost =
              errorMsg.includes('context lost') || errorMsg.includes('Context lost')

            if ((isNotReadable || isContextLost) && attempt < maxRetries) {
              this.logger.warn(
                `Stream export failed (attempt ${attempt + 1}), will retry: ${errorMsg}`
              )
              continue
            }
            throw error
          }
        }
        throw lastError
      }

      if (options.exportMode === 'fast') {
        try {
          return await this.exportVideoFast(options, progressFill, exportStatus, progressCallback)
        } catch (error) {
          // 取消不重试；其余失败整体回退实时录制模式，保证导出一定成功
          if (error instanceof ExportError && error.code === ExportErrorCode.CANCELLED) {
            throw error
          }
          this.logger.warn(
            `Fast export failed (${error instanceof Error ? error.message : error}), ` +
              `falling back to record mode`
          )
          // fast 模式下私有渲染 ticker 是停掉的，回退 record 前必须恢复，
          // 否则 MediaRecorder 录到的是静止画面
          try {
            this.app.pixiApplication.ticker.start()
          } catch {
            /* renderer may already be destroyed */
          }
          this.app.lastSnippetActualDurationMs = 0
          this.app.ttsManager?.clearAudioTracks()
          return await this.exportVideoStream(
            { ...options, exportMode: 'stream' },
            progressFill,
            exportStatus,
            progressCallback
          )
        }
      }

      const { canvas, framesDir, totalSnippets, startSnippetIndex, startFrameIndex } =
        await this.prepareRendering(options, progressFill, exportStatus, progressCallback)
      this.checkAborted()

      const result = await this.captureAndEncodeFrames(
        options,
        canvas,
        framesDir,
        totalSnippets,
        startSnippetIndex,
        startFrameIndex,
        progressFill,
        exportStatus,
        progressCallback
      )

      result.duration = (performance.now() - startTime) / 1000

      this.logger.info('Export completed successfully', {
        duration: result.duration,
        frameCount: result.frameCount
      })

      if (!isApiMode) {
        await this.showCompletionMessage(progressFill!, exportStatus!, progressCallback)
      }

      return result
    } catch (error) {
      return await this.handleExportError(error, exportStatus || document.body, startTime)
    } finally {
      this.cleanup()
    }
  }

  private async exportVideoStream(
    options: VideoExportOptions,
    progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<ExportResult> {
    const startTime = performance.now()
    const isApiMode = options.apiMode === true

    const { canvas, snippets, captureFps } = await this.prepareStreamRecording(
      options,
      progressFill,
      exportStatus,
      onProgress
    )
    this.checkAborted()

    this.logger.info('Starting concurrent stream recording', {
      fps: options.fps,
      captureFps,
      width: options.width,
      height: options.height,
      snippetCount: snippets.length,
      apiMode: isApiMode
    })

    let totalDurationMs = 0
    let timeline: SnippetTimelineEntry[] = []

    const recorder = new StreamRecorder({
      fps: captureFps,
      width: options.width,
      height: options.height,
      bitrate: options.recordBitrate ?? 8_000_000,
      timeslice: 100,
      estimatedDurationMs: undefined,
      // 流拷贝合流路径需要 h264/mp4 录制；off 时保持 webm + 全量重编码
      preferMp4: options.recordStreamCopy !== undefined && options.recordStreamCopy !== 'off'
    })

    recorder.setOnErrorCallback((error) => {
      this.logger.error('StreamRecorder error during recording', error)
    })

    let videoFilePath: string | null = null
    // 宿主收尾（桥接层 finally）会删除输入文件；未走到那一步时由下方兜底删除
    const apiTempFiles: { audioPath: string | null; invoked: boolean } = {
      audioPath: null,
      invoked: false
    }

    let ttsEnabled = this.app.ttsManager?.isTTSEnabled() ?? false
    if (ttsEnabled) {
      this.logger.info('Checking TTS service availability...')
      const available = await this.app.ttsManager!.checkTTSAvailability()
      if (!available) {
        this.logger.warn('TTS service not available. Disabling TTS for this export.')
        ttsEnabled = false
      } else {
        this.logger.info('TTS service available')
      }
    }
    const bgmConfig = this.app.ttsManager?.getBGMConfig()
    const bgmEnabled = bgmConfig?.enabled ?? false
    const audioMuxer = new AudioMuxer()
    if (ttsEnabled || bgmEnabled) {
      await audioMuxer.initialize()
    }

    let bgmBuffer: AudioBuffer | null = null
    if (bgmEnabled && bgmConfig) {
      audioMuxer.setBGMConfig(bgmConfig)
      try {
        const bgmPath = resolveBgmUrl(bgmConfig.path)
        this.logger.info(`Loading BGM from: ${bgmPath}`)
        bgmBuffer = await audioMuxer.loadBGMBuffer(bgmPath)
        this.logger.info(
          `BGM loaded: ${bgmBuffer ? 'success' : 'failed'}, duration: ${bgmBuffer ? bgmBuffer.duration.toFixed(2) : 0}s`
        )
      } catch (error) {
        this.logger.warn(`Failed to load BGM: ${error}`)
      }
    }

    const concurrentPipeline = new ConcurrentExportPipeline({
      ttsLookahead: 3,
      ttsTimeoutMs: 15000,
      targetFps: options.fps
    })

    const timestampRecorder = new SnippetTimestampRecorder()

    const ttsAudioResults = new Map<
      number,
      {
        audioBuffer: ArrayBuffer
        pcmData?: {
          channel0: Float32Array
          channel1: Float32Array
          sampleRate: number
        }
        durationMs: number
        characterName: string
        text: string
        preDecoded: boolean
      }
    >()

    if (ttsEnabled) {
      this.logger.info('Concurrent mode: Starting TTS pipeline in background')
      if (exportStatus) exportStatus.textContent = '启动并发语音合成…'

      timeline = this.app.ttsManager.buildTimelineWithoutTTS(snippets)
      this.app.ttsManager.setTimeline(timeline)

      concurrentPipeline.startTTSPipeline(
        snippets,
        this.app.ttsManager,
        (current, total, message) => {
          this.logger.info(`[TTS Pipeline] ${current}/${total}: ${message}`)
        }
      )
    } else {
      timeline = this.app.ttsManager.buildTimelineWithoutTTS(snippets)
      this.app.ttsManager.setTimeline(timeline)
    }

    totalDurationMs = timeline.length > 0 ? timeline[timeline.length - 1].endTimeMs : 0

    // 流拷贝路径下按目标体积反推录制码率。仅在确认走 mp4 直录时调整——
    // 万一回退 webm + 重编码，被压低的中间码率会实打实损害最终画质。
    // 时长用的是录制前估算（TTS 实际时长通常不低于估算），留 15% 余量。
    const targetSizeMb = options.recordTargetSizeMb ?? 0
    if (targetSizeMb > 0) {
      const streamCopyPlanned =
        options.recordStreamCopy !== undefined &&
        options.recordStreamCopy !== 'off' &&
        StreamRecorder.isMp4RecordingSupported()
      if (streamCopyPlanned && totalDurationMs > 0) {
        const durationSec = totalDurationMs / 1000
        const audioBps = parseBitrateBps(options.apiAudioBitrate ?? '128k')
        const targetBytes = targetSizeMb * 1024 * 1024
        const videoBytes = Math.max(targetBytes * 0.85 - (audioBps / 8) * durationSec, 0)
        const derivedBps = Math.round((videoBytes * 8) / durationSec)
        const finalBps = Math.max(
          MIN_TARGET_BITRATE_BPS,
          Math.min(derivedBps, options.recordBitrate ?? 8_000_000)
        )
        recorder.setVideoBitrate(finalBps)
        this.logger.info(
          `Record size targeting: target=${targetSizeMb}MB, estimated=${durationSec.toFixed(1)}s, ` +
            `audio=${(audioBps / 1000).toFixed(0)}kbps -> videoBitrate=${(finalBps / 1_000_000).toFixed(2)}Mbps`
        )
      } else {
        this.logger.warn(
          'recordTargetSizeMb ignored: requires recordStreamCopy on/auto and mp4 recording support'
        )
      }
    }

    const totalSnippets = snippets.length
    let contextLost = false
    let contextRestoreAttempts = 0
    const MAX_CONTEXT_RESTORE_ATTEMPTS = 3

    const handleContextLost = (event: Event): void => {
      event.preventDefault()
      contextLost = true
      this.logger.error('Canvas WebGL context lost during recording')
    }

    const handleContextRestored = (): void => {
      contextLost = false
      contextRestoreAttempts = 0
      this.logger.info('Canvas WebGL context restored')
    }

    canvas.addEventListener('webglcontextlost', handleContextLost)
    canvas.addEventListener('webglcontextrestored', handleContextRestored)

    try {
      const recordStart = performance.now()
      videoFilePath = await recorder.startRecordingToDisk(canvas)
      concurrentPipeline.markRenderStart()
      timestampRecorder.markRenderStart()

      this.logger.info('Concurrent mode: Video rendering started', {
        fps: options.fps,
        width: options.width,
        height: options.height,
        snippetCount: snippets.length,
        ttsEnabled,
        bgmEnabled
      })

      frameValidator.reset()
      let blackFrameValidationCount = 0

      for (let i = 0; i < snippets.length; i++) {
        this.checkAborted()

        if (contextLost) {
          contextRestoreAttempts++
          if (contextRestoreAttempts > MAX_CONTEXT_RESTORE_ATTEMPTS) {
            this.logger.error('Max context restore attempts reached, aborting')
            throw new Error(
              'Canvas WebGL context was lost and could not be restored after multiple attempts'
            )
          }

          this.logger.warn(
            `Context lost, attempting restore (${contextRestoreAttempts}/${MAX_CONTEXT_RESTORE_ATTEMPTS})...`
          )

          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
          if (gl && gl.isContextLost()) {
            const webglContext = gl as WebGLRenderingContext
            const ext = webglContext.getExtension('WEBGL_lose_context')
            if (ext) {
              ext.restoreContext()
            }
          }

          let waitMs = 0
          while (contextLost && waitMs < 5000) {
            await new Promise((resolve) => setTimeout(resolve, 200))
            waitMs += 200
          }

          if (contextLost) {
            this.logger.error('Context could not be restored within timeout')
            throw new Error('Canvas WebGL context was lost during recording')
          }

          this.logger.info('Context restored, continuing recording')
        }

        const snippet = snippets[i]
        const isTalk = snippet.type === 'Talk'
        const talkData = isTalk
          ? (snippet as { data?: { speaker?: string; content?: string } }).data
          : undefined

        if (ttsEnabled && isTalk) {
          const ttsResult = await concurrentPipeline.waitForTTSReady(i)
          if (ttsResult && ttsResult.success && ttsResult.duration > 0) {
            const timelineEntry = timeline[i]
            const oldDurationMs = timelineEntry?.durationMs ?? 0
            const newDurationMs = Math.max(oldDurationMs, ttsResult.duration + TTS_TAIL_SILENCE_MS)
            const durationDelta = newDurationMs - oldDurationMs

            timeline[i] = {
              ...timelineEntry,
              ttsDurationMs: ttsResult.duration,
              hasTTS: true,
              durationMs: newDurationMs,
              endTimeMs: (timelineEntry?.startTimeMs ?? 0) + newDurationMs
            }

            if (durationDelta > 0) {
              // 原地累加后续条目：保持数组与对象标识不变（ttsManager 持有同一数组），
              // 同时避免每条 TTS 都重建整条时间轴
              for (let j = i + 1; j < timeline.length; j++) {
                const later = timeline[j]
                later.startTimeMs += durationDelta
                later.endTimeMs += durationDelta
              }
            }

            const rawAudioBuffer = this.app.ttsManager.getAudioBufferForSnippet(i)
            if (rawAudioBuffer) {
              ttsAudioResults.set(i, {
                audioBuffer: rawAudioBuffer,
                durationMs: ttsResult.duration,
                characterName: talkData?.speaker ?? '',
                text: talkData?.content ?? '',
                preDecoded: false
              })
            }
          } else {
            // TTS 未接入或合成失败：按字数生成台词时长（打字机 + 阅读停留），保证句间呼吸
            const timelineEntry = timeline[i]
            const fallbackMs = estimateSnippetDuration(snippet)
            if (timelineEntry && timelineEntry.durationMs < fallbackMs) {
              const durationDelta = fallbackMs - timelineEntry.durationMs
              timeline[i] = {
                ...timelineEntry,
                durationMs: fallbackMs,
                endTimeMs: timelineEntry.startTimeMs + fallbackMs
              }
              for (let j = i + 1; j < timeline.length; j++) {
                const later = timeline[j]
                later.startTimeMs += durationDelta
                later.endTimeMs += durationDelta
              }
            }
          }
        }

        const timelineEntry = timeline[i]
        const pct = 30 + Math.round(((i + 1) / totalSnippets) * 60)

        if (progressFill) progressFill.style.width = `${pct}%`
        if (exportStatus) {
          const ttsStatus =
            ttsEnabled && isTalk ? (concurrentPipeline.isTTSReady(i) ? '✓' : '⏳') : ''
          if (exportStatus)
            exportStatus.textContent = `渲染中… ${i + 1}/${totalSnippets} ${ttsStatus}`
        }

        onProgress({
          stage: 'capturing',
          current: i + 1,
          total: totalSnippets,
          message: `处理片段 ${i + 1}/${totalSnippets}`,
          percentage: pct
        })

        this.app.lastSnippetActualDurationMs =
          timelineEntry?.durationMs ??
          Math.max(Math.round(snippet.delay * 1000), estimateSnippetDuration(snippet))

        timestampRecorder.markSnippetStart(i, snippet.type, {
          speaker: talkData?.speaker,
          content: talkData?.content
        })

        // 渲染片段 - 片段间的延迟由 snippet.delay 控制，不由帧率控制器控制
        await this.app.snippetStrategyManager.handleSnippetForExport(snippet)

        if (i < 5 || (i + 1) % 30 === 0) {
          const frameValidation = frameValidator.validateFrame(canvas, i)
          if (!frameValidation.isValid && frameValidation.error) {
            throw new Error(
              `Rendering validation failed at snippet ${i + 1}: ${frameValidation.error}. ` +
                `Brightness: ${frameValidation.brightness.toFixed(2)}%. ` +
                `Aborting export to prevent black screen video output.`
            )
          }
          if (frameValidation.isBlackScreen) {
            blackFrameValidationCount++
            this.logger.warn(
              `Black frame detected at snippet ${i + 1} (count: ${blackFrameValidationCount})`
            )
            if (blackFrameValidationCount >= 5) {
              throw new Error(
                `Detected ${blackFrameValidationCount} black frames during export. ` +
                  `Models are not rendering. Aborting to prevent empty video output.`
              )
            }
          } else {
            blackFrameValidationCount = 0
          }
        }

        const ttsDur = ttsAudioResults.get(i)?.durationMs
        timestampRecorder.markSnippetEnd(ttsDur)

        if (i % 50 === 0) {
          this.logger.info(
            `Snippet ${i}: type=${snippet.type}, duration=${timelineEntry?.durationMs}ms, ttsReady=${ttsEnabled && isTalk ? concurrentPipeline.isTTSReady(i) : 'N/A'}`
          )
        }

        // 优化: 更频繁地让出主线程，但批量处理
        if (i % 30 === 0) {
          await this.yieldToBrowser()
        }
      }

      concurrentPipeline.markRenderEnd()
      timestampRecorder.logSummary()

      videoFilePath = await recorder.stopRecordingToDisk()
      const recordMs = performance.now() - recordStart
      this.logger.info(`Video recorded to disk: ${videoFilePath} (recordMs=${recordMs.toFixed(0)})`)

      onProgress({
        stage: 'saving',
        current: 1,
        total: 1,
        message: '正在保存视频...',
        percentage: 95
      })

      if (exportStatus) exportStatus.textContent = '正在保存视频...'

      this.logger.info('Phase 3: Audio mixing and final assembly')

      const actualVideoDurationMs = timestampRecorder.getTotalVideoDurationMs()
      const recordingDurationMs = performance.now() - startTime
      totalDurationMs = Math.max(actualVideoDurationMs, recordingDurationMs) + 500

      const hasTtsTracks = ttsEnabled && ttsAudioResults.size > 0
      this.logger.info(
        `Audio check: ttsEnabled=${ttsEnabled}, ttsAudioResults=${ttsAudioResults.size}, hasTtsTracks=${hasTtsTracks}`
      )

      let mergeMs = 0
      if (isApiMode) {
        if (!videoFilePath) {
          throw new Error('Video file path is not available after recording')
        }
        const mergeStart = performance.now()
        await this.saveApiVideoFromDisk(
          options,
          videoFilePath,
          hasTtsTracks,
          bgmBuffer,
          bgmEnabled,
          audioMuxer,
          totalDurationMs,
          exportStatus,
          onProgress,
          ttsAudioResults,
          timestampRecorder,
          {
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            recordedBitrate: options.recordBitrate ?? 8_000_000,
            recordedMimeType: recorder.getLastMimeType(),
            tempFiles: apiTempFiles
          }
        )
        mergeMs = performance.now() - mergeStart
        this.logger.info(
          `Record export phase timings: record=${recordMs.toFixed(0)}ms ` +
            `merge=${mergeMs.toFixed(0)}ms ` +
            `videoDuration=${(totalDurationMs / 1000).toFixed(1)}s`
        )
      } else if (hasTtsTracks || (bgmBuffer && bgmEnabled)) {
        if (hasTtsTracks) {
          this.logger.info(
            `Mixing ${ttsAudioResults.size} audio tracks using timestamp-based placement...`
          )
          if (exportStatus)
            exportStatus.textContent = `正在混合音频 (${ttsAudioResults.size} 条音轨)...`

          const audioPlacements = timestampRecorder.buildAudioTrackPlacements(ttsAudioResults)

          for (const placement of audioPlacements) {
            audioMuxer.addAudioTrack({
              audioBuffer: placement.audioBuffer,
              pcmData: placement.pcmData,
              startTime: placement.startTimeMs,
              endTime: placement.endTimeMs,
              characterName: placement.characterName,
              text: placement.text
            })
            this.logger.info(
              `Audio placed: "${placement.characterName}" at ${placement.startTimeMs}ms → ${placement.endTimeMs}ms (ttsDur=${placement.endTimeMs - placement.startTimeMs}ms)`
            )
          }
        } else {
          this.logger.info('No TTS tracks, BGM only mode')
          if (exportStatus) exportStatus.textContent = '正在添加背景音乐...'
        }

        this.logger.info(
          `Audio mixing: outputDuration=${totalDurationMs}ms, bgmBuffer=${bgmBuffer ? 'loaded' : 'none'}, bgmEnabled=${bgmEnabled}`
        )
        const mixedAudioBuffer = await audioMuxer.mixAudioTracks(
          totalDurationMs,
          bgmBuffer || undefined
        )
        const wavBuffer = await audioMuxer.audioBufferToWav(mixedAudioBuffer)

        this.logger.info(
          `WAV buffer size: ${(wavBuffer.byteLength / 1024).toFixed(1)} KB, duration: ${(mixedAudioBuffer.duration * 1000).toFixed(0)}ms`
        )

        if (exportStatus) exportStatus.textContent = '正在写入临时文件...'
        const audioTempPath = await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
          data: wavBuffer,
          prefix: 'mss-audio',
          extension: 'wav'
        })

        this.logger.info(`Temp files: video=${videoFilePath}, audio=${audioTempPath}`)

        if (exportStatus) exportStatus.textContent = '正在合并音视频...'
        await window.electron.ipcRenderer.invoke('electron:merge-video-audio-files', {
          videoPath: videoFilePath,
          audioPath: audioTempPath,
          gpuRenderer: options.gpuRenderer || 'auto',
          crf: options.crf ?? 18
        })
      } else {
        this.logger.info('No audio to export (TTS and BGM both disabled)')

        if (exportStatus) exportStatus.textContent = '正在编码视频...'
        await window.electron.ipcRenderer.invoke('electron:convert-video-file', {
          videoPath: videoFilePath,
          gpuRenderer: options.gpuRenderer || 'auto',
          crf: options.crf ?? 18
        })
      }

      const result = {
        success: true,
        duration: (performance.now() - startTime) / 1000,
        // 与实际采集帧率一致（recordCaptureFps 调低时同步变化）
        frameCount: Math.round((totalDurationMs / 1000) * captureFps),
        timings: isApiMode
          ? {
              recordMs: Math.round(recordMs),
              mergeMs: Math.round(mergeMs),
              videoDurationMs: Math.round(totalDurationMs)
            }
          : undefined
      }

      this.logger.info('Concurrent stream recording completed successfully', result)

      if (!isApiMode) {
        await this.showCompletionMessage(progressFill!, exportStatus!, onProgress)
      }

      return result
    } catch (error) {
      this.logger.error('Concurrent stream recording failed', error)
      throw error
    } finally {
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      canvas.removeEventListener('webglcontextrestored', handleContextRestored)
      // 临时文件兜底清理：未进入宿主收尾时（取消/异常/重试）桥接层不会删除输入；
      // 成功路径下桥接层只删文件不删目录，这里统一 rm -rf 整个 per-export 目录
      // （force 语义：已删除的路径静默跳过）。重试循环每次 attempt 独立目录，同样覆盖。
      const webmDir = videoFilePath ? videoFilePath.replace(/\/[^/]*$/, '') : null
      await this.removeTempPaths([webmDir, apiTempFiles.audioPath])
      await concurrentPipeline.dispose()
      recorder.dispose()
      audioMuxer.dispose()
      this.app.ttsManager?.clearAudioTracks()
    }
  }

  /** best-effort 删除导出临时文件/目录（不存在时静默） */
  private async removeTempPaths(paths: Array<string | null | undefined>): Promise<void> {
    for (const target of paths) {
      if (!target) continue
      try {
        await window.electron.ipcRenderer.invoke('electron:delete-temp-file', {
          filePath: target
        })
      } catch (error) {
        this.logger.warn(`Failed to remove temp path: ${target}`, error)
      }
    }
  }

  /**
   * fast 模式页内编码路径选择：
   * - 'frames'：直接走 JPEG 帧序列
   * - 'webcodecs'：只要 WebCodecs 可用就用
   * - 'auto'：WebCodecs 可用，但 Linux+NVIDIA（软编 OpenH264，极慢）时改走帧序列
   */
  private async resolveFastUseWebCodecs(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    fps: number,
    bitrate: number,
    choice: 'auto' | 'webcodecs' | 'frames'
  ): Promise<boolean> {
    if (choice === 'frames') return false
    const available = (await WebCodecsMp4Encoder.resolveConfig(width, height, fps, bitrate)) !== null
    if (!available) return false
    if (choice === 'webcodecs') return true

    try {
      const gl =
        canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
        canvas.getContext('webgl', { preserveDrawingBuffer: true })
      if (!gl) return true
      const dbg = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info')
      const renderer = dbg
        ? String((gl as WebGLRenderingContext).getParameter(dbg.UNMASKED_RENDERER_WEBGL))
        : ''
      const isLinux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)
      const isNvidia = /nvidia|geforce|quadro/i.test(renderer)
      if (isLinux && isNvidia) {
        this.logger.warn(
          `Fast export: Linux+NVIDIA detected (${renderer}); ` +
            `WebCodecs would use software OpenH264, using JPEG frames + ffmpeg HW encoder instead`
        )
        return false
      }
    } catch {
      // 探测失败按原样用 WebCodecs
    }
    return true
  }

  /**
   * fast 导出模式：虚拟时钟逐帧渲染 + 页内 WebCodecs 直编。
   *
   * 与 stream/record 的差异：
   * - 时间由 VirtualClockController.tickAsync 推进，不再等墙钟。
   * - TTS 与渲染重叠；等 TTS 时暂停帧泵，等待走真实时钟，
   *   不把等待时间编进视频。
   * - 抓帧用 VideoFrame(canvas)：不受显示器 vsync 限制，才能快于墙钟。
   *   captureStream+requestFrame 受真实 vsync 约束，虚拟时钟下会和片段
   *   setTimeout 死锁，因此不用。
   */
  private async exportVideoFast(
    options: VideoExportOptions,
    progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<ExportResult> {
    const { canvas, snippets } = await this.prepareStreamRecording(
      options,
      progressFill,
      exportStatus,
      onProgress
    )
    this.checkAborted()

    const fps = options.fps
    const outW = options.width
    const outH = options.height
    const bitrate = options.exportBitrate ?? 12_000_000
    // 编码帧率独立于时间轴：动画仍按 options.fps 的虚拟时间推进，
    // 但每帧 GPU 读回很贵。用 video.fastFps（默认 30）封顶，时长不变。
    const fastFpsCap = Math.max(1, Math.min(options.fastFps ?? 30, fps))
    const encodeFps = fastFpsCap
    const frameMs = 1000 / encodeFps

    this.logger.info('Starting fast export (virtual clock)', {
      fps,
      encodeFps,
      width: outW,
      height: outH,
      bitrate,
      snippetCount: snippets.length
    })

    let ttsEnabled = this.app.ttsManager?.isTTSEnabled() ?? false
    if (ttsEnabled) {
      this.logger.info('Checking TTS service availability...')
      const available = await this.app.ttsManager!.checkTTSAvailability()
      if (!available) {
        this.logger.warn('TTS service not available. Disabling TTS for this export.')
        ttsEnabled = false
      }
    }

    const bgmConfig = this.app.ttsManager?.getBGMConfig()
    const bgmEnabled = bgmConfig?.enabled ?? false
    const audioMuxer = new AudioMuxer()
    if (ttsEnabled || bgmEnabled) {
      await audioMuxer.initialize()
    }

    let bgmBuffer: AudioBuffer | null = null
    if (bgmEnabled && bgmConfig) {
      audioMuxer.setBGMConfig(bgmConfig)
      try {
        const bgmPath = resolveBgmUrl(bgmConfig.path)
        bgmBuffer = await audioMuxer.loadBGMBuffer(bgmPath)
      } catch (error) {
        this.logger.warn(`Failed to load BGM: ${error}`)
      }
    }

    const ttsAudioResults = new Map<
      number,
      {
        audioBuffer: ArrayBuffer
        pcmData?: { channel0: Float32Array; channel1: Float32Array; sampleRate: number }
        durationMs: number
        characterName: string
        text: string
        preDecoded: boolean
      }
    >()

    const timeline: SnippetTimelineEntry[] = this.app.ttsManager.buildTimelineWithoutTTS(snippets)
    this.app.ttsManager.setTimeline(timeline)

    const virtualClock = new VirtualClockController()
    const timestampRecorder = new SnippetTimestampRecorder()
    const concurrentPipeline = new ConcurrentExportPipeline({
      ttsLookahead: 3,
      ttsTimeoutMs: 15000,
      targetFps: fps,
      waitMs: (ms) => virtualClock.realSleep(ms),
      nowMs: () => virtualClock.realTimeMs()
    })

    if (ttsEnabled) {
      this.logger.info('Concurrent mode: Starting TTS pipeline in background')
      concurrentPipeline.startTTSPipeline(
        snippets,
        this.app.ttsManager,
        (current, total, message) => {
          this.logger.info(`[TTS Pipeline] ${current}/${total}: ${message}`)
        }
      )
    }

    // ---- 帧接收器：优先 WebCodecs 直编 MP4，回退 JPEG 帧序列 ----
    // Linux + NVIDIA 的 Chromium 没有 NVENC/VAAPI，WebCodecs 只会落到
    // OpenH264 纯软编（~200ms/帧@1080p），远慢于「JPEG 帧序列 + ffmpeg
    // NVENC」。这类环境自动改走帧序列路径；可用 exportFastEncoder 强制。
    const useWebCodecs = await this.resolveFastUseWebCodecs(
      canvas,
      outW,
      outH,
      encodeFps,
      bitrate,
      options.exportFastEncoder ?? 'auto'
    )

    // sink 由 createSink 异步创建；放进对象属性可避免 TS 控制流把裸 let
    // 收窄成 never（异步赋值不参与收窄）。
    const sinks: {
      encoder: WebCodecsMp4Encoder | null
      jpegSink: JpegFrameSink | null
      framesDir: string | null
    } = { encoder: null, jpegSink: null, framesDir: null }

    const createSink = async (): Promise<void> => {
      if (sinks.encoder || sinks.jpegSink) return
      if (useWebCodecs) {
        const tempDir = await window.electron.ipcRenderer.invoke('electron:get-temp-base-dir')
        const videoFilePath = `${tempDir}/mss-fast-${Date.now()}.mp4`
        const encoder = new WebCodecsMp4Encoder({
          width: outW,
          height: outH,
          fps: encodeFps,
          bitrate
        })
        await encoder.initialize(videoFilePath)
        sinks.encoder = encoder
        this.logger.info(`Fast export: WebCodecs MP4 → ${videoFilePath}`)
      } else {
        const dir = (await window.electron.ipcRenderer.invoke('electron:get-temp-dir')) as string
        // 中间帧用高质量 JPEG：块噪声更少，成品码率更低、画质更好；
        // 帧只临时落盘，不占成品体积
        const jpegSink = new JpegFrameSink({
          width: outW,
          height: outH,
          quality: Math.max(this.getJpegQuality(options.quality), 0.92),
          framesDir: dir
        })
        await jpegSink.initialize(canvas)
        sinks.jpegSink = jpegSink
        sinks.framesDir = dir
      }
    }

    await createSink()

    const realStart = virtualClock.realTimeMs()

    // fast 模式每帧只渲染一次：
    // pixi 的 Application 用私有 ticker（maxFPS=0 不限速），而 VirtualClockController
    // 只接管 Ticker.shared。私有 ticker 跨过 install 后改挂假 rAF，于是每次
    // tickAsync(frameMs)（假 rAF 是 16ms 栅格）会触发 2~3 次完整 renderer.render()，
    // 其中只有最后一次的画面被捕获——其余全是纯浪费。
    // 这里停掉私有渲染 ticker，由帧泵在 tick 之后显式 render 一次；Live2D 参数
    // 更新仍走 Ticker.shared（帧数不变），因此画面与改造前一致。
    this.app.pixiApplication.ticker.stop()
    this.logger.info('Fast export: app render ticker stopped, rendering once per frame')

    virtualClock.install()
    timestampRecorder.markRenderStart()
    concurrentPipeline.markRenderStart()

    // 分段计时（真实墙钟；虚拟时钟下 performance.now 是虚拟时间）
    let pumpMs = 0
    let tickMs = 0
    let renderMs = 0
    let snapshotMs = 0
    let ttsWaitMs = 0
    let encodeMs = 0
    let audioMs = 0
    let invokeMs = 0

    let pumpPaused = false
    let pumpDone = false
    /** 尾部追帧目标（虚拟毫秒）：片段循环结束后让帧泵跑到这个虚拟时间再停，
     *  避免最后几帧（TTS 尾垫、刚结束的出场动画）被丢导致视频戛然而止 */
    let pumpTargetVirtualMs = -1
    let pumpError: Error | null = null
    let blackFrameValidationCount = 0
    frameValidator.reset()
    let frameIndex = 0

    const framePump = (async (): Promise<void> => {
      try {
        // 退出条件：请求停止 且 已追上尾部目标虚拟时间（追帧期间 pumpPaused 不生效）
        const shouldStop = (): boolean => {
          if (!pumpDone) return false
          if (pumpTargetVirtualMs < 0) return true
          return virtualClock.now() >= pumpTargetVirtualMs
        }
        while (!shouldStop()) {
          this.checkAborted()
          if (pumpPaused && !pumpDone) {
            await virtualClock.realSleep(4)
            continue
          }
          const frameStart = virtualClock.realTimeMs()

          const tickStart = virtualClock.realTimeMs()
          await virtualClock.tick(frameMs)
          tickMs += virtualClock.realTimeMs() - tickStart

          // 显式渲染一次（私有渲染 ticker 已停）；放在 tick 之后可保证
          // Live2D 参数更新完才绘制，捕获到的是最新状态
          const renderStart = virtualClock.realTimeMs()
          this.app.pixiApplication.render()
          renderMs += virtualClock.realTimeMs() - renderStart

          const timestampUs = Math.round(frameIndex * (1_000_000 / encodeFps))
          const durationUs = Math.round(1_000_000 / encodeFps)
          const keyFrame = frameIndex % (encodeFps * 4) === 0

          const captureStart = virtualClock.realTimeMs()
          if (sinks.encoder) {
            await sinks.encoder.encodeFrame(canvas, timestampUs, durationUs, keyFrame)
          } else if (sinks.jpegSink) {
            await sinks.jpegSink.captureFrame(canvas)
          }
          snapshotMs += virtualClock.realTimeMs() - captureStart

          if (frameIndex % (encodeFps * 5) === 0) {
            const v = frameValidator.validateFrame(canvas, frameIndex)
            if (!v.isValid && v.error) {
              throw new Error(
                `Rendering validation failed at frame ${frameIndex}: ${v.error}. ` +
                  `Brightness: ${v.brightness.toFixed(2)}%`
              )
            }
            if (v.isBlackScreen) {
              blackFrameValidationCount++
              if (blackFrameValidationCount >= 5) {
                throw new Error(
                  `Detected ${blackFrameValidationCount} black frames during fast export. ` +
                    `Models are not rendering.`
                )
              }
            } else {
              blackFrameValidationCount = 0
            }
          }

          frameIndex++
          pumpMs += virtualClock.realTimeMs() - frameStart
        }
      } catch (e) {
        pumpError = e instanceof Error ? e : new Error(String(e))
      }
    })()

    try {
      const totalSnippets = snippets.length

      for (let i = 0; i < totalSnippets; i++) {
        this.checkAborted()
        if (pumpError) throw pumpError

        const snippet = snippets[i]
        const isTalk = snippet.type === 'Talk'
        const talkData = isTalk
          ? (snippet as { data?: { speaker?: string; content?: string } }).data
          : undefined

        if (ttsEnabled && isTalk) {
          pumpPaused = true
          const ttsWaitStart = virtualClock.realTimeMs()
          const ttsResult = await concurrentPipeline.waitForTTSReady(i)
          ttsWaitMs += virtualClock.realTimeMs() - ttsWaitStart
          pumpPaused = false
          if (pumpError) throw pumpError

          if (ttsResult && ttsResult.success && ttsResult.duration > 0) {
            applyTalkPatch(timeline, i, ttsResult.duration)
            const rawAudioBuffer = this.app.ttsManager.getAudioBufferForSnippet(i)
            if (rawAudioBuffer) {
              ttsAudioResults.set(i, {
                audioBuffer: rawAudioBuffer,
                durationMs: ttsResult.duration,
                characterName: talkData?.speaker ?? '',
                text: talkData?.content ?? '',
                preDecoded: false
              })
            }
          } else {
            // TTS 未接入或合成失败：按字数生成台词时长（打字机 + 阅读停留），保证句间呼吸
            applyTalkPatch(timeline, i, 0, estimateSnippetDuration(snippet))
          }
          this.app.ttsManager.setTimeline(timeline)
        }

        const timelineEntry = timeline[i]
        const pct = 30 + Math.round(((i + 1) / totalSnippets) * 60)
        if (progressFill) progressFill.style.width = `${pct}%`
        onProgress({
          stage: 'capturing',
          current: i + 1,
          total: totalSnippets,
          message: `处理片段 ${i + 1}/${totalSnippets}`,
          percentage: pct
        })

        this.app.lastSnippetActualDurationMs =
          timelineEntry?.durationMs ??
          Math.max(Math.round(snippet.delay * 1000), estimateSnippetDuration(snippet))

        timestampRecorder.markSnippetStart(i, snippet.type, {
          speaker: talkData?.speaker,
          content: talkData?.content
        })

        await this.app.snippetStrategyManager.handleSnippetForExport(snippet)

        const ttsDur = ttsAudioResults.get(i)?.durationMs
        timestampRecorder.markSnippetEnd(ttsDur)
      }

      // 尾部追帧：让帧泵渲染到「最后一个片段的虚拟结束时间」，
      // 保证 TTS 尾垫与出场动画的最后一帧都在视频里
      const lastTimelineEntry = timeline[timeline.length - 1]
      pumpTargetVirtualMs = Math.max(
        virtualClock.now(),
        lastTimelineEntry ? lastTimelineEntry.endTimeMs : virtualClock.now()
      )
      pumpDone = true
      await framePump
      if (pumpError) throw pumpError

      concurrentPipeline.markRenderEnd()
      timestampRecorder.logSummary()

      let videoFilePath: string
      const encodeStart = virtualClock.realTimeMs()
      if (sinks.encoder) {
        videoFilePath = await sinks.encoder.finish()
      } else {
        videoFilePath = await sinks.jpegSink!.finish()
      }
      encodeMs = virtualClock.realTimeMs() - encodeStart

      virtualClock.uninstall()

      const actualVideoDurationMs = timestampRecorder.getTotalVideoDurationMs()
      const totalDurationMs = actualVideoDurationMs + 500
      const hasTtsTracks = ttsEnabled && ttsAudioResults.size > 0

      let audioFilePath: string | undefined
      if (hasTtsTracks || (bgmBuffer && bgmEnabled)) {
        const audioStart = virtualClock.realTimeMs()
        if (hasTtsTracks) {
          const audioPlacements = timestampRecorder.buildAudioTrackPlacements(ttsAudioResults)
          for (const placement of audioPlacements) {
            audioMuxer.addAudioTrack({
              audioBuffer: placement.audioBuffer,
              pcmData: placement.pcmData,
              startTime: placement.startTimeMs,
              endTime: placement.endTimeMs,
              characterName: placement.characterName,
              text: placement.text
            })
          }
        }

        const mixedAudioBuffer = await audioMuxer.mixAudioTracks(
          totalDurationMs,
          bgmBuffer || undefined
        )
        const wavBuffer = await audioMuxer.audioBufferToWav(mixedAudioBuffer)
        audioFilePath = await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
          data: wavBuffer,
          prefix: 'mss-audio',
          extension: 'wav'
        })
        audioMs = virtualClock.realTimeMs() - audioStart
      }

      if (exportStatus) exportStatus.textContent = '正在合成视频…'
      onProgress({
        stage: 'saving',
        current: 1,
        total: 1,
        message: '正在合成视频...',
        percentage: 95
      })

      const outputPath = options.apiOutputPath ?? ''
      const audioBitrate = options.apiAudioBitrate ?? '128k'

      let saveResult: { success: boolean; error?: string; fileSize?: number }
      const invokeStart = virtualClock.realTimeMs()
      if (sinks.encoder) {
        saveResult = await window.electron.ipcRenderer.invoke(
          'electron:api-remux-video-from-files',
          {
            videoPath: videoFilePath,
            audioPath: audioFilePath,
            outputPath,
            audioBitrate
          }
        )
      } else {
        if (!sinks.framesDir) throw new Error('JPEG frame sink produced no frames directory')
        saveResult = await window.electron.ipcRenderer.invoke('electron:api-encode-frames-video', {
          framesDir: sinks.framesDir,
          audioPath: audioFilePath,
          outputPath,
          fps: encodeFps,
          audioBitrate
        })
      }
      invokeMs = virtualClock.realTimeMs() - invokeStart

      if (!saveResult?.success) {
        throw new Error(saveResult?.error || 'Video assembly failed on host')
      }

      const timings: Record<string, number> = {
        pumpMs: Math.round(pumpMs),
        tickMs: Math.round(tickMs),
        renderMs: Math.round(renderMs),
        snapshotMs: Math.round(snapshotMs),
        ttsWaitMs: Math.round(ttsWaitMs),
        encodeMs: Math.round(encodeMs),
        audioMs: Math.round(audioMs),
        invokeMs: Math.round(invokeMs),
        frames: frameIndex,
        avgPumpFps: pumpMs > 0 ? Math.round((frameIndex / (pumpMs / 1000)) * 10) / 10 : 0
      }

      const result = {
        success: true,
        duration: (virtualClock.realTimeMs() - realStart) / 1000,
        frameCount: Math.round((totalDurationMs / 1000) * encodeFps),
        outputSize: saveResult.fileSize,
        timings
      }

      this.logger.info(
        `Fast export phase timings: pump=${pumpMs.toFixed(0)}ms ` +
          `(tick=${tickMs.toFixed(0)}ms render=${renderMs.toFixed(0)}ms ` +
          `capture=${snapshotMs.toFixed(0)}ms) ` +
          `ttsWait=${ttsWaitMs.toFixed(0)}ms encode=${encodeMs.toFixed(0)}ms ` +
          `audio=${audioMs.toFixed(0)}ms invoke=${invokeMs.toFixed(0)}ms ` +
          `frames=${frameIndex} ` +
          `avgPumpFps=${pumpMs > 0 ? (frameIndex / (pumpMs / 1000)).toFixed(1) : '0'}`
      )
      this.logger.info('Fast export completed', result)
      return result
    } catch (error) {
      pumpDone = true
      pumpPaused = false
      await framePump.catch(() => undefined)
      this.logger.error('Fast export failed', error)
      throw error
    } finally {
      try {
        virtualClock.uninstall()
      } catch {
        /* already uninstalled */
      }
      // 恢复私有渲染 ticker：record 回退路径与后续任务都要靠它出画面
      try {
        this.app.pixiApplication.ticker.start()
        this.logger.info('Fast export: app render ticker restored')
      } catch {
        /* renderer may already be destroyed */
      }
      sinks.encoder?.dispose()
      if (sinks.jpegSink) await sinks.jpegSink.dispose()
      await concurrentPipeline.dispose()
      audioMuxer.dispose()
      this.app.ttsManager?.clearAudioTracks()
    }
  }

  private async prepareStreamRecording(
    options: VideoExportOptions,
    _progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    _onProgress: InternalProgressCallback
  ): Promise<{ canvas: HTMLCanvasElement; snippets: SnippetData[]; captureFps: number }> {
    const isApiMode = options.apiMode === true

    AnimationManager.setExportMode(true)
    AnimationManager.exportSpeedMultiplier = 1
    const isFastLike = options.exportMode === 'fast'
    const fastFpsCap = Math.max(1, Math.min(options.fastFps ?? 30, options.fps))
    AnimationManager.exportTargetFPS = isFastLike ? fastFpsCap : options.fps
    if (isFastLike) {
      Ticker.shared.maxFPS = fastFpsCap
    }

    // 采集帧率：默认跟随 video.fps；显式调低时编码量随之下降。
    // 注意 StreamRecorder 的 fps 只用于 captureStream/约束/日志，
    // 不影响片段时长（墙钟驱动）与 ffmpeg 的 -r 参数。
    const captureFps =
      options.recordCaptureFps && options.recordCaptureFps > 0
        ? Math.max(1, Math.min(Math.round(options.recordCaptureFps), options.fps))
        : options.fps
    if (!isFastLike && captureFps < options.fps) {
      // 采集降帧的同时把渲染上限压到 video.fps：导出模式默认 120fps 上限，
      // 而动画步进本就是 options.fps，多出的绘制纯属浪费 GPU
      Ticker.shared.maxFPS = options.fps
      this.logger.info(
        `Record capture fps capped to ${captureFps} (from ${options.fps}), ` +
          `render ticker capped to ${options.fps}`
      )
    }

    if (isApiMode) {
      this.logger.info('API mode: skipping story reload, using pre-initialized story data')
    }

    const canvas = this.app.pixiApplication.view as HTMLCanvasElement
    this.logger.info(`Canvas size: ${canvas.width}x${canvas.height}`)

    if (canvas.width === 0 || canvas.height === 0) {
      throw ExportError.invalidCanvas(canvas.width, canvas.height)
    }

    const snippets = this.app.storyManager.snippets

    this.logger.info('Performing pre-export WebGL validation...')
    if (exportStatus) exportStatus.textContent = '正在验证渲染环境...'

    const validationResult = await webGLValidator.validateCanvas(canvas)
    if (!validationResult.success) {
      const errorDetails = validationResult.errors.join('; ')
      this.logger.error('WebGL validation failed before export:', validationResult)
      throw new Error(
        `WebGL rendering validation failed: ${errorDetails}. ` +
          `Please check GPU drivers, model files, and rendering environment. ` +
          `GPU: ${validationResult.contextInfo.renderer || 'unknown'}`
      )
    }

    this.logger.info('Validating model rendering output...')
    if (exportStatus) exportStatus.textContent = '正在验证模型渲染...'

    await new Promise((resolve) => setTimeout(resolve, 500))
    const modelValidation = await webGLValidator.validateModelRendering(canvas, 3000)
    if (!modelValidation.success) {
      throw new Error(
        `Model rendering validation failed: black screen detected ` +
          `(brightness: ${modelValidation.averageBrightness.toFixed(2)}%). ` +
          `Models are not rendering properly. Check WebGL context and model files.`
      )
    }

    this.logger.info('Pre-export validation passed')

    return { canvas, snippets, captureFps }
  }

  private async initializeExport(
    _options: VideoExportOptions,
    _progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<void> {
    this.logger.info('Initializing export')

    onProgress({
      stage: 'initializing',
      current: 0,
      total: 1,
      message: '正在初始化渲染器…',
      percentage: 0
    })

    if (exportStatus) exportStatus.textContent = '正在初始化渲染器…'
    await this.yieldToBrowser()
  }

  private async prepareRendering(
    options: VideoExportOptions,
    _progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<{
    canvas: HTMLCanvasElement
    framesDir: string
    totalSnippets: number
    startSnippetIndex: number
    startFrameIndex: number
  }> {
    const isApiMode = options.apiMode === true

    AnimationManager.setExportMode(true)
    AnimationManager.exportSpeedMultiplier = 1
    AnimationManager.exportTargetFPS = options.fps

    this.logger.info('Animation speed multiplier: 1x')

    if (isApiMode) {
      this.logger.info('API mode: skipping story reload, using pre-initialized story data')
    }

    const canvas = this.app.pixiApplication.view as HTMLCanvasElement
    this.logger.info(`Canvas size: ${canvas.width}x${canvas.height}`)

    if (canvas.width === 0 || canvas.height === 0) {
      throw ExportError.invalidCanvas(canvas.width, canvas.height)
    }

    onProgress({
      stage: 'capturing',
      current: 0,
      total: 1,
      message: '正在捕获帧…',
      percentage: 0
    })

    if (exportStatus) exportStatus.textContent = '正在准备流式编码…'
    await this.yieldToBrowser()
    await this.requestAnimationFrameOnce()

    const framesDir = await window.electron.ipcRenderer.invoke('electron:get-temp-dir')
    this.logger.info(`Temp frames directory: ${framesDir}`)

    const snippets = this.app.storyManager.snippets
    const totalSnippets = snippets.length

    let startSnippetIndex = 0
    let startFrameIndex = 0

    if (options.enableResumable !== false && this.checkpointManager.hasCheckpoint()) {
      const checkpoint = this.checkpointManager.loadCheckpoint()
      if (checkpoint && this.checkpointManager.canResume(totalSnippets)) {
        this.logger.info('Resuming from checkpoint', checkpoint)
        startSnippetIndex = checkpoint.lastSnippetIndex
        startFrameIndex = checkpoint.lastFrameIndex
      }
    }

    return {
      canvas,
      framesDir,
      totalSnippets,
      startSnippetIndex,
      startFrameIndex
    }
  }

  private async captureAndEncodeFrames(
    options: VideoExportOptions,
    canvas: HTMLCanvasElement,
    framesDir: string,
    totalSnippets: number,
    startSnippetIndex: number,
    startFrameIndex: number,
    progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<ExportResult> {
    const captureStartTime = performance.now()
    const snippets = this.app.storyManager.snippets
    let frameIndex = startFrameIndex
    let capturedFrames = 0

    const jpegQuality = this.getJpegQuality(options.quality)
    const batchSize = options.batchSize || VideoExportManager.DEFAULT_BATCH_SIZE

    const capturer = new AsyncFrameCapturer(this.logger, {
      width: options.width,
      height: options.height,
      quality: jpegQuality,
      batchSize,
      framesDir,
      maxQueueSize: 60,
      concurrentCaptures: 8
    })

    await capturer.initialize(canvas)

    const ttsEnabled = this.app.ttsManager?.isTTSEnabled() ?? false
    const bgmConfig = this.app.ttsManager?.getBGMConfig()
    const bgmEnabled = bgmConfig?.enabled ?? false
    const audioMuxer = new AudioMuxer()
    if (ttsEnabled || bgmEnabled) {
      await audioMuxer.initialize()
    }

    let bgmBuffer: AudioBuffer | null = null
    if (bgmEnabled && bgmConfig) {
      audioMuxer.setBGMConfig(bgmConfig)
      try {
        const bgmPath = resolveBgmUrl(bgmConfig.path)
        this.logger.info(`Loading BGM from: ${bgmPath}`)
        bgmBuffer = await audioMuxer.loadBGMBuffer(bgmPath)
        this.logger.info(
          `BGM loaded: ${bgmBuffer ? 'success' : 'failed'}, duration: ${bgmBuffer ? bgmBuffer.duration.toFixed(2) : 0}s`
        )
      } catch (error) {
        this.logger.warn(`Failed to load BGM: ${error}`)
      }
    }

    let timeline: SnippetTimelineEntry[] = []

    timeline = this.app.ttsManager.buildTimelineWithoutTTS(snippets)
    this.app.ttsManager.setTimeline(timeline)

    this.logger.info(
      'Phase 2: High-concurrency async rendering — Frame Capture + Snippet execution',
      {
        totalSnippets,
        startIndex: startSnippetIndex,
        fps: options.fps,
        ttsEnabled,
        bgmEnabled
      }
    )

    const timestampRecorder = new SnippetTimestampRecorder()
    timestampRecorder.markRenderStart()

    const ttsAudioResults = new Map<
      number,
      {
        audioBuffer: ArrayBuffer
        pcmData?: {
          channel0: Float32Array
          channel1: Float32Array
          sampleRate: number
        }
        durationMs: number
        characterName: string
        text: string
        preDecoded: boolean
      }
    >()

    let ttsPromise: Promise<void> | null = null

    if (ttsEnabled) {
      this.logger.info('Starting TTS synthesis in background')
      if (exportStatus) exportStatus.textContent = '启动语音合成（后台运行）…'

      ttsPromise = (async () => {
        await this.app.ttsManager.preSynthesizeAll(snippets, (current, total, message) => {
          this.logger.info(`[TTS Background] ${current}/${total}: ${message}`)
        })
        this.logger.info('TTS background synthesis completed')
      })()
    }

    try {
      for (let i = startSnippetIndex; i < snippets.length; i++) {
        this.checkAborted()

        const snippet = snippets[i]
        const timelineEntry = timeline[i]
        const safeTotal = totalSnippets || 1
        const pct = 10 + Math.round(((i + 1) / safeTotal) * 80)

        if (progressFill) progressFill.style.width = `${pct}%`
        if (exportStatus) exportStatus.textContent = `渲染中… ${i + 1}/${totalSnippets}`

        onProgress({
          stage: 'capturing',
          current: i + 1,
          total: totalSnippets,
          message: `处理片段 ${i + 1}/${totalSnippets}`,
          percentage: pct
        })

        this.app.lastSnippetActualDurationMs =
          timelineEntry?.durationMs ??
          Math.max(Math.round(snippet.delay * 1000), estimateSnippetDuration(snippet))

        const isTalk = snippet.type === 'Talk'
        const talkData = isTalk
          ? (snippet as { data?: { speaker?: string; content?: string } }).data
          : undefined

        timestampRecorder.markSnippetStart(i, snippet.type, {
          speaker: talkData?.speaker,
          content: talkData?.content
        })

        const framesForSnippet = await this.processSnippetFrames(
          snippet,
          i,
          options.fps,
          canvas,
          capturer
        )

        frameIndex += framesForSnippet
        capturedFrames += framesForSnippet

        timestampRecorder.markSnippetEnd()

        if (capturedFrames % 50 === 0) {
          this.checkpointManager.saveCheckpoint({
            lastSnippetIndex: i,
            lastFrameIndex: frameIndex,
            totalFramesCaptured: capturedFrames,
            timestamp: Date.now(),
            exportOptions: {
              fps: options.fps,
              quality: options.quality,
              width: options.width,
              height: options.height
            }
          })
        }

        if (i % 20 === 0) {
          await this.yieldToBrowser()
        }
      }
    } catch (error) {
      this.logger.error('Frame capture loop failed, cleaning up resources', error)
      try {
        await capturer.dispose()
      } catch {
        /* cleanup */
      }
      audioMuxer.dispose()
      if (ttsEnabled) {
        this.app.ttsManager?.clearAudioTracks()
      }
      throw error
    }

    timestampRecorder.logSummary()

    await capturer.flushAll()

    this.logger.info(`Frame capture completed: ${capturedFrames} frames`)

    if (ttsEnabled && ttsPromise) {
      this.logger.info('Waiting for TTS synthesis to complete...')
      if (exportStatus) exportStatus.textContent = '等待语音合成完成…'
      await ttsPromise
      this.logger.info('TTS synthesis finished')

      const ttsDurations = this.app.ttsManager.getPreSynthesizedTtsDurations()
      const audioTracks = this.app.ttsManager.getAudioTracks()
      let talkIdx = 0

      for (let i = 0; i < snippets.length; i++) {
        if (snippets[i].type === 'Talk') {
          const duration = ttsDurations.get(i) ?? timeline[i]?.durationMs ?? 0
          const track = audioTracks[talkIdx]

          if (track) {
            ttsAudioResults.set(i, {
              audioBuffer: track.audioBuffer,
              durationMs: duration,
              characterName: track.characterName,
              text: track.text,
              preDecoded: false
            })
          }

          talkIdx++
        }
      }

      this.logger.info(`Collected ${ttsAudioResults.size} TTS audio tracks after synthesis`)
    }

    const actualVideoDurationMs = timestampRecorder.getTotalVideoDurationMs()
    const videoDurationMs = (frameIndex / options.fps) * 1000
    const lastTimelineEntry = timeline[timeline.length - 1]
    const totalDurationMs =
      Math.max(lastTimelineEntry?.endTimeMs ?? 0, videoDurationMs, actualVideoDurationMs) + 500

    const hasTtsTracks = ttsEnabled && ttsAudioResults.size > 0
    let wavData: Uint8Array | null = null

    this.logger.info('Phase 3: Audio mixing', {
      hasTtsTracks,
      ttsCount: ttsAudioResults.size,
      bgmEnabled
    })

    if ((hasTtsTracks || (bgmBuffer && bgmEnabled)) && (ttsEnabled || bgmEnabled)) {
      if (hasTtsTracks) {
        if (exportStatus)
          exportStatus.textContent = `正在混合音频 (${ttsAudioResults.size} 条音轨)...`

        const audioPlacements = timestampRecorder.buildAudioTrackPlacements(ttsAudioResults)

        for (const placement of audioPlacements) {
          audioMuxer.addAudioTrack({
            audioBuffer: placement.audioBuffer,
            startTime: placement.startTimeMs,
            endTime: placement.endTimeMs,
            characterName: placement.characterName,
            text: placement.text
          })
          this.logger.info(
            `Audio placed: "${placement.characterName}" at ${placement.startTimeMs}ms → ${placement.endTimeMs}ms`
          )
        }
      } else if (bgmEnabled) {
        if (exportStatus) exportStatus.textContent = '正在添加背景音乐...'
      }

      this.logger.info(
        `Audio mixing: outputDuration=${totalDurationMs}ms, tracks=${ttsAudioResults.size}, bgm=${!!bgmBuffer}`
      )
      const mixedAudioBuffer = await audioMuxer.mixAudioTracks(
        totalDurationMs,
        bgmBuffer || undefined
      )
      const wavBuffer = await audioMuxer.audioBufferToWav(mixedAudioBuffer)
      wavData = new Uint8Array(wavBuffer)
      this.logger.info(`WAV buffer prepared: ${(wavBuffer.byteLength / 1024).toFixed(1)} KB`)
    }

    onProgress({
      stage: 'encoding',
      current: frameIndex,
      total: frameIndex,
      message: '正在编码视频…',
      percentage: 95
    })

    if (exportStatus) exportStatus.textContent = '正在编码视频…'
    await this.sleep(200)

    onProgress({
      stage: 'saving',
      current: frameIndex,
      total: frameIndex,
      message: '正在保存视频…',
      percentage: 98
    })

    if (exportStatus) exportStatus.textContent = '正在保存视频…'

    await this.encodeAndSaveVideo(framesDir, frameIndex, options, wavData ?? undefined)
    this.checkAborted()

    this.checkpointManager.clearCheckpoint()
    audioMuxer.dispose()
    if (ttsEnabled) {
      this.app.ttsManager?.clearAudioTracks()
    }
    await capturer.dispose()

    this.logger.info('Frame capture summary', {
      totalFrames: capturedFrames,
      capturerStats: capturer.stats
    })

    return {
      success: true,
      duration: (performance.now() - captureStartTime) / 1000,
      frameCount: capturedFrames
    }
  }

  private getJpegQuality(quality: 'draft' | 'standard' | 'high'): number {
    switch (quality) {
      case 'draft':
        return 0.7
      case 'standard':
        return 0.8
      case 'high':
      default:
        return 0.85
    }
  }

  private async showCompletionMessage(
    progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<void> {
    if (progressFill) progressFill.style.width = '100%'

    onProgress({
      stage: 'complete',
      current: 1,
      total: 1,
      message: '视频已保存！',
      percentage: 100
    })

    if (exportStatus) exportStatus.textContent = '视频已保存！'
    await this.sleep(1500)
  }

  private async handleExportError(
    error: unknown,
    exportStatus: HTMLElement | null,
    _startTime: number
  ): Promise<ExportResult> {
    this.logger.error('Export failed', error)

    const errorMsg = error instanceof Error ? error.message : String(error)
    const errorCode = error instanceof ExportError ? error.code : ExportErrorCode.UNKNOWN

    if (errorCode === ExportErrorCode.CANCELLED) {
      if (exportStatus) exportStatus.textContent = '导出已取消'
    } else if (errorCode === ExportErrorCode.TIMEOUT) {
      if (exportStatus) exportStatus.textContent = '导出超时，请尝试减少片段数或降低分辨率'
    } else {
      if (exportStatus) exportStatus.textContent = `导出失败: ${errorMsg.substring(0, 50)}`
    }

    throw error
  }

  private cleanup(): void {
    AnimationManager.setExportMode(false)
    AnimationManager.exportSpeedMultiplier = 1
    this.app.exporting = false
    this.app.lastSnippetActualDurationMs = 0

    this.app.ttsManager?.clearAudioTracks()

    Ticker.shared.stop()

    const overlay = document.getElementById('export-overlay')
    if (overlay) {
      overlay.hidden = true
    }

    this.logger.info('Export cleanup completed, Ticker stopped to reduce GPU idle usage')
  }

  private async encodeAndSaveVideo(
    framesDir: string,
    frameCount: number,
    options: VideoExportOptions,
    audioData?: Uint8Array
  ): Promise<void> {
    const startTime = performance.now()
    this.logger.info(
      `Starting video encoding: ${frameCount} frames, ${options.fps}fps, format=${options.format}, quality=${options.quality}, gpuRenderer=${options.gpuRenderer || 'auto'}, hasAudio=${!!audioData}`
    )

    let audioFilePath: string | undefined
    if (audioData && audioData.byteLength > 0) {
      audioFilePath = await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
        data: audioData.buffer.slice(
          audioData.byteOffset,
          audioData.byteOffset + audioData.byteLength
        ),
        prefix: 'mss-audio',
        extension: 'wav'
      })
      this.logger.info(
        `Audio temp file: ${audioFilePath}, size=${(audioData.byteLength / 1024).toFixed(1)} KB`
      )
    }

    await window.electron.ipcRenderer.invoke('electron:hyperframes-save-video', {
      framesDir,
      frameCount,
      keyFrameCount: 0,
      fps: options.fps,
      width: options.width,
      height: options.height,
      totalDuration: frameCount / options.fps,
      gpuRenderer: options.gpuRenderer || 'auto',
      audioFilePath
    })

    const encodeTime = ((performance.now() - startTime) / 1000).toFixed(2)
    this.logger.info(`Video encoding completed in ${encodeTime}s`)
  }

  private async saveApiVideoFromDisk(
    options: VideoExportOptions,
    videoFilePath: string,
    hasTtsTracks: boolean,
    bgmBuffer: AudioBuffer | null,
    bgmEnabled: boolean,
    audioMuxer: AudioMuxer,
    totalDurationMs: number,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback,
    ttsAudioResults: Map<
      number,
      {
        audioBuffer: ArrayBuffer
        pcmData?: {
          channel0: Float32Array
          channel1: Float32Array
          sampleRate: number
        }
        durationMs: number
        characterName: string
        text: string
        preDecoded: boolean
      }
    >,
    timestampRecorder: SnippetTimestampRecorder,
    finalizeInfo: {
      /** 录制文件的实际像素尺寸（画布后备存储） */
      canvasWidth: number
      canvasHeight: number
      /** 录制时使用的视频码率（bps） */
      recordedBitrate: number
      /** 录制实际使用的 MIME 类型 */
      recordedMimeType: string | null
      /** 临时文件追踪：invoked 置位后由桥接层或本方法负责删除 */
      tempFiles: { audioPath: string | null; invoked: boolean }
    }
  ): Promise<void> {
    const crf = options.apiCrf ?? 23
    const audioBitrate = options.apiAudioBitrate ?? '128k'
    const outputPath = options.apiOutputPath ?? ''
    const { canvasWidth, canvasHeight, recordedBitrate, recordedMimeType, tempFiles } = finalizeInfo

    this.logger.info(
      `API save from disk: videoPath=${videoFilePath}, outputPath=${outputPath}, crf=${crf}, ` +
        `input=${canvasWidth}x${canvasHeight}, mime=${recordedMimeType ?? 'unknown'}`
    )

    let audioFilePath: string | undefined

    if (hasTtsTracks || (bgmBuffer && bgmEnabled)) {
      if (exportStatus) exportStatus.textContent = 'API: 正在混合音频...'
      onProgress({
        stage: 'saving',
        current: 1,
        total: 2,
        message: 'API: 正在混合音频...',
        percentage: 96
      })

      if (hasTtsTracks) {
        this.logger.info(
          `API: Mixing ${ttsAudioResults.size} audio tracks using timestamp-based placement...`
        )
        const audioPlacements = timestampRecorder.buildAudioTrackPlacements(ttsAudioResults)

        for (const placement of audioPlacements) {
          audioMuxer.addAudioTrack({
            audioBuffer: placement.audioBuffer,
            pcmData: placement.pcmData,
            startTime: placement.startTimeMs,
            endTime: placement.endTimeMs,
            characterName: placement.characterName,
            text: placement.text
          })
          this.logger.info(
            `API Audio placed: "${placement.characterName}" at ${placement.startTimeMs}ms → ${placement.endTimeMs}ms`
          )
        }
      }

      // 混音直出 Int16 交错 PCM（与旧 Float32→WAV 路径数学一致），
      // 避免全时长双 Float32Array + AudioBuffer 拷贝 + 逐样本 setInt16
      const pcm = await audioMuxer.mixToInt16Interleaved(
        totalDurationMs,
        bgmBuffer || undefined
      )
      const wavBuffer = audioMuxer.encodeWavFromInt16(pcm)

      this.logger.info(`API: Audio mixed, size=${(wavBuffer.byteLength / 1024).toFixed(1)} KB`)

      audioFilePath = await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
        data: wavBuffer,
        prefix: 'mss-api-audio',
        extension: 'wav'
      })
      tempFiles.audioPath = audioFilePath ?? null
      this.logger.info(`API: Audio temp file: ${audioFilePath}`)
    }

    if (exportStatus) exportStatus.textContent = 'API: 正在压缩并保存视频...'
    onProgress({
      stage: 'saving',
      current: 2,
      total: 2,
      message: 'API: 正在压缩并保存视频...',
      percentage: 98
    })

    // 已中止则不进入宿主编码：渲染结果直接丢弃，worker 立即释放。
    // 中止时 audioFilePath 尚未被桥接层管理，由 exportVideoStream 的 finally 兜底删除。
    this.checkAborted()

    // h264/mp4 直录时走流拷贝合流（-c:v copy），省掉整个宿主重编码；
    // 任一环节失败都保留输入并回退下方的全量重编码路径
    const canStreamCopy =
      options.recordStreamCopy !== undefined &&
      options.recordStreamCopy !== 'off' &&
      (recordedMimeType ?? '').includes('mp4')

    if (canStreamCopy) {
      try {
        tempFiles.invoked = true
        const copyResult = await window.electron.ipcRenderer.invoke(
          'electron:api-remux-video-from-files',
          {
            videoPath: videoFilePath,
            audioPath: audioFilePath,
            outputPath,
            audioBitrate,
            keepInputs: true
          }
        )
        if (copyResult?.success) {
          await this.removeTempPaths([videoFilePath, audioFilePath])
          this.logger.info(
            `API: Video stream-copied to ${copyResult.outputPath}, ` +
              `size=${((copyResult.fileSize || 0) / 1024 / 1024).toFixed(2)} MB`
          )
          return
        }
        this.logger.warn(
          `API: Stream copy failed (${copyResult?.error || 'unknown'}), falling back to re-encode`
        )
      } catch (copyError) {
        this.logger.warn('API: Stream copy invoke failed, falling back to re-encode', copyError)
      }
    }

    tempFiles.invoked = true
    const apiResult = await window.electron.ipcRenderer.invoke(
      'electron:api-export-video-from-files',
      {
        videoPath: videoFilePath,
        audioPath: audioFilePath,
        outputPath,
        fps: options.fps,
        width: options.width,
        height: options.height,
        crf,
        audioBitrate,
        inputWidth: canvasWidth,
        inputHeight: canvasHeight,
        recordedBitrate
      }
    )

    if (!apiResult.success) {
      throw new Error(`API video export failed: ${apiResult.error || 'Unknown error'}`)
    }

    this.logger.info(
      `API: Video saved to ${apiResult.outputPath}, size=${((apiResult.fileSize || 0) / 1024 / 1024).toFixed(2)} MB`
    )
  }

  private async saveApiVideo(
    options: VideoExportOptions,
    videoUint8Array: Uint8Array,
    hasTtsTracks: boolean,
    bgmBuffer: AudioBuffer | null,
    bgmEnabled: boolean,
    audioMuxer: AudioMuxer,
    totalDurationMs: number,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback,
    ttsAudioResults: Map<
      number,
      {
        audioBuffer: ArrayBuffer
        pcmData?: {
          channel0: Float32Array
          channel1: Float32Array
          sampleRate: number
        }
        durationMs: number
        characterName: string
        text: string
        preDecoded: boolean
      }
    >,
    timestampRecorder: SnippetTimestampRecorder
  ): Promise<void> {
    const crf = options.apiCrf ?? 23
    const audioBitrate = options.apiAudioBitrate ?? '128k'
    const outputPath = options.apiOutputPath ?? ''

    this.logger.info(`API save: outputPath=${outputPath}, crf=${crf}, audioBitrate=${audioBitrate}`)

    let audioData: ArrayBuffer | undefined

    if (hasTtsTracks || (bgmBuffer && bgmEnabled)) {
      if (exportStatus) exportStatus.textContent = 'API: 正在混合音频...'
      onProgress({
        stage: 'saving',
        current: 1,
        total: 2,
        message: 'API: 正在混合音频...',
        percentage: 96
      })

      if (hasTtsTracks) {
        this.logger.info(
          `API: Mixing ${ttsAudioResults.size} audio tracks using timestamp-based placement...`
        )
        const audioPlacements = timestampRecorder.buildAudioTrackPlacements(ttsAudioResults)

        for (const placement of audioPlacements) {
          audioMuxer.addAudioTrack({
            audioBuffer: placement.audioBuffer,
            pcmData: placement.pcmData,
            startTime: placement.startTimeMs,
            endTime: placement.endTimeMs,
            characterName: placement.characterName,
            text: placement.text
          })
          this.logger.info(
            `API Audio placed: "${placement.characterName}" at ${placement.startTimeMs}ms → ${placement.endTimeMs}ms`
          )
        }
      }

      const mixedAudioBuffer = await audioMuxer.mixAudioTracks(
        totalDurationMs,
        bgmBuffer || undefined
      )
      const wavBuffer = await audioMuxer.audioBufferToWav(mixedAudioBuffer)
      audioData = wavBuffer

      this.logger.info(`API: Audio mixed, size=${(wavBuffer.byteLength / 1024).toFixed(1)} KB`)
    }

    if (exportStatus) exportStatus.textContent = 'API: 正在压缩并保存视频...'
    onProgress({
      stage: 'saving',
      current: 2,
      total: 2,
      message: 'API: 正在压缩并保存视频...',
      percentage: 98
    })

    const apiResult = await window.electron.ipcRenderer.invoke('electron:api-export-stream-video', {
      videoData: videoUint8Array.buffer.slice(
        videoUint8Array.byteOffset,
        videoUint8Array.byteOffset + videoUint8Array.byteLength
      ),
      audioData: audioData,
      outputPath,
      fps: options.fps,
      width: options.width,
      height: options.height,
      crf,
      audioBitrate
    })

    if (!apiResult.success) {
      throw new Error(`API video export failed: ${apiResult.error || 'Unknown error'}`)
    }

    this.logger.info(
      `API: Video saved to ${apiResult.outputPath}, size=${((apiResult.fileSize || 0) / 1024 / 1024).toFixed(2)} MB`
    )
  }

  destroy(): void {
    this.abort()
    this.checkpointManager.clearCheckpoint()
    this.logger.info('VideoExportManager destroyed')
  }
}
