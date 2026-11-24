/**
 * 帧泵帧数：成片帧 n 覆盖故事帧 floor(n×60/fps)，plan 的 N 个故事帧必须泵出
 * `ceil(N×fps/60)` 个输出帧（参考 `sse-export Clock::frames`）。
 *
 * 25fps 是回归点：plan=77 故事帧时 77×1000/60 = 1283.33ms，按 40ms 输出帧
 * 「四舍五入到最近帧」只得到 32 帧，而参考是 ceil(77×25/60)=33。旧实现把
 * 目标虚拟时刻 round 到最近输出帧，非整除帧率会少拍 1 帧（24fps 同样）。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { test } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import { createRendererLoader } from './lib/renderer-loader.mjs'

const root = process.cwd()
const rendererRoot = path.join(root, 'src/renderer/src')
const noop = () => {}

const SNIPPETS = [
  { type: 'BlackOut', delay: 0, wait: true, data: { color: 'black', duration: 0 } },
  { type: 'PlaySe', delay: 0, wait: true, data: { se: 'se_test', timing: 'before' } },
  { type: 'BlackOut', delay: 0, wait: true, data: { color: 'black', duration: 600 } }
]

const TIMELINE = [
  {
    snippetIndex: 0,
    snippetType: 'BlackOut',
    delayStartTimeMs: 0,
    startTimeMs: 0,
    durationMs: 0,
    endTimeMs: 0,
    ttsDurationMs: 0,
    hasTTS: false,
    blocking: true,
    durationSource: 'fixed'
  },
  {
    snippetIndex: 1,
    snippetType: 'PlaySe',
    delayStartTimeMs: 0,
    startTimeMs: 0,
    durationMs: 0,
    endTimeMs: 0,
    ttsDurationMs: 0,
    hasTTS: false,
    blocking: true,
    durationSource: 'fixed'
  },
  {
    snippetIndex: 2,
    snippetType: 'BlackOut',
    delayStartTimeMs: 0,
    startTimeMs: 0,
    durationMs: 600,
    endTimeMs: 600,
    ttsDurationMs: 0,
    hasTTS: false,
    blocking: true,
    durationSource: 'fixed'
  }
]

test('fast export pumps ceil(plan × fps / 60) frames at a non-divisible 25fps', async (t) => {
  const realSetTimeoutFn = setTimeout
  const loader = createRendererLoader(new Map(), {
    window: {
      electron: {
        ipcRenderer: {
          invoke: async (ch) => {
            if (ch === 'electron:frames-stream-start')
              return { id: 'pipe-1', videoPath: '/tmp/vid.mp4' }
            if (ch === 'electron:frames-stream-finish') return { videoPath: '/tmp/vid.mp4' }
            if (ch === 'electron:api-remux-video-from-files')
              return { success: true, fileSize: 999 }
            if (ch === 'electron:write-temp-file') return '/tmp/audio.wav'
            return { success: true }
          }
        }
      }
    },
    OfflineAudioContext: class {
      async decodeAudioData() {
        return {
          numberOfChannels: 2,
          sampleRate: 48000,
          getChannelData: () => new Float32Array(4800).fill(0.2)
        }
      }
    }
  })

  let virtualClock = null
  t.after(() => virtualClock?.uninstall())

  const { mocks } = loader
  const logger = { info: noop, warn: noop, error: noop, debug: noop }
  const { SnippetTimestampRecorder } = loader.load(
    'managers/video-export/SnippetTimestampRecorder.ts'
  )
  const { applyTalkPatch } = loader.load('managers/video-export/talkPatch.ts')
  const { bakeStoryPlan } = loader.load('../../common/export/storyPlan.ts')
  const { storyFrameForVideoFrame } = loader.load('../../common/official/timing.ts')

  let capturedFrames = 0
  let storySteps = 0
  /** 每次采集时的故事步数：成片帧 n 必须是 floor(n×60/fps) 步之后的状态。 */
  const capturedSteps = []

  mocks.set('pixi.js', {
    Text: class {},
    AlphaFilter: class {},
    TextStyle: class {},
    Ticker: { shared: { maxFPS: 60, stop: noop, start: noop } }
  })
  mocks.set('pixi-live2d-display-advanced', {
    Cubism4InternalModel: class extends EventEmitter {},
    Cubism2InternalModel: class extends EventEmitter {}
  })
  mocks.set(path.join(rendererRoot, 'utils/Logger.ts'), { __esModule: true, default: () => logger })
  mocks.set(path.join(rendererRoot, 'utils/WebGLContextValidator.ts'), {
    webGLValidator: {
      validateCanvas: async () => ({
        success: true,
        errors: [],
        contextInfo: { renderer: 'TestGPU' }
      }),
      validateModelRendering: async () => ({ success: true, averageBrightness: 80 })
    }
  })
  mocks.set(path.join(rendererRoot, 'utils/FrameContentValidator.ts'), {
    frameValidator: {
      reset: noop,
      validateFrame: () => ({ isValid: true, isBlackScreen: false, brightness: 80 })
    }
  })
  mocks.set(path.join(rendererRoot, 'utils/ResourceUrl.ts'), { resolveBgmUrl: (p) => p })
  mocks.set(path.join(rendererRoot, 'managers/AnimationManager.ts'), {
    __esModule: true,
    default: {
      setExportMode: noop,
      exportSpeedMultiplier: 1,
      exportTargetFPS: 60,
      exportEncodeFPS: 25,
      dispatchExportStep: () => {
        storySteps++
      },
      delay: async () => {}
    }
  })
  mocks.set(path.join(rendererRoot, 'snippets/stageTiming.ts'), {
    getLayoutRunningEndMs: () => 0,
    getMotionSettledEndMs: () => 0,
    resetStageTiming: noop
  })
  mocks.set('./video-export', {
    ExportLogger: class {
      info = noop
      warn = noop
      error = noop
    },
    CheckpointManager: class {
      clearCheckpoint = noop
      hasCheckpoint = () => false
    },
    ErrorRecoveryManager: class {
      reset = noop
    },
    ProgressTracker: class {
      start = noop
      update = noop
    },
    ExportError: class extends Error {
      constructor(c, m) {
        super(m)
        this.code = c
      }
    },
    ExportErrorCode: { CANCELLED: 'CANCELLED', TIMEOUT: 'TIMEOUT', UNKNOWN: 'UNKNOWN' },
    AudioMuxer: class {
      initialize = async () => {}
      setBGMConfig = noop
      setSeCues = noop
      setBgmCues = noop
      addAudioTrack = noop
      mixToInt16Interleaved = async () => new Int16Array(960)
      encodeWavFromInt16 = () => new ArrayBuffer(128)
      dispose = noop
    },
    ConcurrentExportPipeline: class {
      startTTSPipeline = noop
      isTTSReady = () => false
      getTTSResult = () => null
      waitForTTSReady = async () => null
      waitForTTSPipeline = async () => {}
      markRenderStart = noop
      markRenderEnd = noop
      dispose = async () => {}
    },
    SnippetTimestampRecorder,
    exportTraceContext: { setSnippet: noop, reset: noop },
    motionTrace: { reset: noop, snapshot: () => [] },
    exportLogBus: { reset: noop, snapshot: () => [] },
    buildExportDiagnostics: () => ({ summary: {} }),
    sanitizeDiagnostics: (d) => d
  })
  mocks.set('./video-export/VirtualClockController', {
    VirtualClockController: class {
      install() {
        virtualClock = FakeTimers.withGlobal(loader.context).install({
          now: 0,
          toFake: [
            'Date',
            'performance',
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            'setImmediate',
            'clearImmediate'
          ]
        })
      }
      uninstall() {
        virtualClock?.uninstall()
        virtualClock = null
      }
      now = () => (virtualClock ? virtualClock.now : 0)
      realTimeMs = () => performance.now()
      realSleep = (ms) => new Promise((r) => realSetTimeoutFn(r, ms))
      tick = (ms) => virtualClock.tickAsync(ms)
      advanceStorySteps = async (steps, onStep) => {
        for (let i = 0; i < Math.floor(steps); i++) {
          await virtualClock.tickAsync(1000 / 60)
          onStep?.(virtualClock.now)
        }
      }
    }
  })
  mocks.set('./video-export/BgmPlan', {
    BgmPlan: class {
      hasStoryFiles = false
      hasLoadedFiles = false
      hasChanges = false
      load = async () => {}
    }
  })
  mocks.set('./video-export/SePlan', {
    SePlan: class {
      hasChanges = false
      load = async () => {}
      build = () => []
    }
  })
  mocks.set('./video-export/WebCodecsMp4Encoder', {
    WebCodecsMp4Encoder: class {
      static async probeConfig() {
        return {
          config: { codec: 'avc1.640028', width: 1280, height: 720 },
          glRenderer: 'TestGPU',
          elapsedMs: 10
        }
      }
      async initialize() {
        throw new Error('use JpegFrameSink')
      }
      async encodeFrame() {}
      async finish() {
        return '/tmp/pipe/video.mp4'
      }
      dispose() {}
    }
  })
  mocks.set('./video-export/JpegFrameSink', {
    JpegFrameSink: class {
      get isPipeMode() {
        return true
      }
      get framesDirectory() {
        return ''
      }
      async initialize() {}
      async captureFrame() {
        capturedFrames++
        capturedSteps.push(storySteps)
      }
      async finish() {
        return '/tmp/pipe/video.mp4'
      }
      async dispose() {}
    }
  })
  mocks.set('./video-export/talkPatch', { applyTalkPatch })

  const VideoExportManager = loader.load('managers/VideoExportManager.ts').default
  const canvas = {
    width: 1280,
    height: 720,
    getContext: () => ({
      isContextLost: () => false,
      getExtension: () => null,
      getParameter: () => ''
    })
  }

  const encodings = []
  const app = {
    exporting: false,
    lastSnippetActualDurationMs: 0,
    currentTalkStartedAtMs: 0,
    currentTalkLipSync: null,
    storyManager: { snippets: SNIPPETS, storyData: { models: [], images: [] } },
    pixiApplication: {
      view: canvas,
      ticker: { start: noop, stop: noop },
      render: noop,
      renderer: { render: noop },
      stage: {}
    },
    layerModel: { isModelVisible: () => true },
    layerSpecialEffect: { fadeOut: async () => {} },
    setOpeningCover: async () => {},
    setEndingEnvelope: async (hold, fade) => {
      encodings.push({ hold, fade })
    },
    ttsManager: {
      isTTSEnabled: () => false,
      checkTTSAvailability: async () => true,
      getBGMConfig: () => ({ enabled: false }),
      getConfig: () => ({ timeoutMs: 90_000 }),
      buildTimelineWithoutTTS: () => TIMELINE,
      setTimeline: noop,
      clearAudioTracks: noop
    },
    snippetStrategyManager: {
      resetBackgroundSnippets: noop,
      handleSnippetForExport: async (s) => {
        if (s.type === 'BlackOut' && s.data?.duration) {
          await new Promise((r) => loader.context.setTimeout(r, s.data.duration))
        }
      }
    }
  }

  // 与 VideoExportManager 内部相同的 plan 输入（空 settle/clip 表、无 TTS）。
  const plan = bakeStoryPlan(SNIPPETS, TIMELINE, { exportFps: 25, ttsEnabled: false })
  assert.equal(plan.totalFrames, 77, 'fixture plan must stay at 77 story frames')
  const expectedFrames = Math.ceil((plan.totalFrames * 25) / 60)
  assert.equal(expectedFrames, 33, '77 story frames at 25fps is 33 video frames')
  // 旧的「round 到最近输出帧」会得到 32：1283.33ms / 40ms = 32.08。
  assert.equal(Math.round((plan.totalFrames * (1000 / 60)) / (1000 / 25)), 32)

  const mgr = new VideoExportManager(app)
  const res = await mgr.exportVideo({
    fps: 60,
    fastFps: 25,
    width: 1280,
    height: 720,
    quality: 'high',
    format: 'mp4',
    exportMode: 'fast',
    exportFastEncoder: 'auto',
    apiMode: true,
    apiOutputPath: '/tmp/frame-pump-25fps.mp4'
  })

  assert.equal(res.success, true)
  assert.equal(res.frameCount, 33, 'API frameCount must be ceil(plan×25/60)')
  assert.equal(res.timings.frames, 33, 'report frames must be the plan-derived count')
  assert.equal(res.timings.encodedFrames, 33, 'the pump must actually render 33 frames')
  assert.equal(capturedFrames, 33, 'sink captures one frame per output frame')
  // 帧泵顺序：成片帧 n 先推进到故事帧 floor(n×60/25)，再渲染/采集该帧。
  const expectedSteps = Array.from({ length: expectedFrames }, (_, k) =>
    storyFrameForVideoFrame(k, 25)
  )
  assert.deepEqual(
    capturedSteps,
    expectedSteps,
    `each output frame must capture the state of its own story frame: ` +
      `got [${capturedSteps.join(',')}], want [${expectedSteps.join(',')}]`
  )
  assert.ok(
    capturedSteps.every((steps, k) => k === 0 || steps > capturedSteps[k - 1]),
    'story steps must advance monotonically between output frames'
  )
  // `-t` 截断用的是同一帧数：33/25 = 1.32s。
  assert.equal(res.duration, 33 / 25)
  assert.equal(res.timings.videoDurationMs, 1320)
  assert.equal(encodings.length, 1, 'ending envelope still runs once')
})
